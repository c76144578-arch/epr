"""Backend do site de consulta de placas - pagamentos SafiPay (PIX).

Serve o site estatico e expoe a API de pagamento:
  POST /api/pagamento/criar   -> cria cobranca PIX na SafiPay
  GET  /api/pagamento/status  -> consulta status da transacao
  POST /api/webhooks/safipay  -> recebe notificacoes da SafiPay

Variaveis de ambiente:
  SAFIPAY_CLIENT_ID, SAFIPAY_CLIENT_SECRET, SAFIPAY_WEBHOOK_SECRET
  SITE_DIR (pasta do site estatico), PORT
"""
import os, json, time, hmac, hashlib, logging, io, base64, re
from functools import wraps

import requests
import qrcode
from flask import Flask, request, jsonify, send_from_directory, abort

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
def _site_dir():
    for cand in (os.environ.get('SITE_DIR'), os.path.join(BASE_DIR, 'site'), os.path.join(BASE_DIR, '..', 'site')):
        if cand and os.path.isdir(cand):
            return cand
    return os.path.join(BASE_DIR, 'site')
SITE_DIR = _site_dir()
SAFIPAY_BASE = 'https://www.safipaybr.com/api/gateway'
DATA_DIR = os.path.join(BASE_DIR, 'data')
os.makedirs(DATA_DIR, exist_ok=True)
ORDERS_FILE = os.path.join(DATA_DIR, 'pedidos.json')
WEBHOOK_LOG = os.path.join(DATA_DIR, 'webhooks.log')
VISITS_FILE = os.path.join(DATA_DIR, 'visitas.json')

logging.basicConfig(level=logging.INFO)
log = logging.getLogger('pagamento')

app = Flask(__name__, static_folder=None)


def _load_visits():
    try:
        with open(VISITS_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _save_visits(v):
    tmp = VISITS_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(v, f)
    os.replace(tmp, VISITS_FILE)


@app.before_request
def contar_visita():
    if request.method != 'GET':
        return
    p = request.path
    if p.startswith('/api/') or not (p == '/' or p.endswith('.html')):
        return
    dia = time.strftime('%Y-%m-%d', time.gmtime())
    vid = hashlib.sha256(((request.headers.get('X-Forwarded-For') or request.remote_addr or '') + '|' + request.headers.get('User-Agent', '') + '|' + dia).encode()).hexdigest()[:20]
    v = _load_visits()
    d = v.setdefault(dia, {'total': 0, 'unicos': []})
    d['total'] += 1
    if vid not in d['unicos']:
        d['unicos'].append(vid)
        if len(d['unicos']) > 50000:
            d['unicos'] = d['unicos'][-50000:]
    for k in [k for k in v if k < time.strftime('%Y-%m-%d', time.gmtime(time.time() - 60*86400))]:
        del v[k]
    _save_visits(v)


@app.get('/admin/stats')
def stats():
    v = _load_visits()
    linhas = ''
    total_geral = 0
    for dia in sorted(v.keys(), reverse=True):
        d = v[dia]
        total_geral += d['total']
        linhas += f'<tr><td>{dia}</td><td>{d["total"]}</td><td>{len(d["unicos"])}</td></tr>'
    hoje = time.strftime('%Y-%m-%d', time.gmtime())
    h = v.get(hoje, {'total': 0, 'unicos': []})
    html = f'''<!doctype html><html><head><meta charset="utf-8"><title>Stats</title>
<style>body{{font-family:Arial;background:#003057;color:#fff;padding:30px}}table{{border-collapse:collapse}}td,th{{border:1px solid #71cc98;padding:8px 18px}}</style></head><body>
<h1 style="color:#71cc98">Visitas</h1>
<p>Hoje: <b>{h["total"]}</b> pageviews | <b>{len(h["unicos"])}</b> visitantes únicos</p>
<p>Total geral: <b>{total_geral}</b> pageviews</p>
<table><tr><th>Dia (UTC)</th><th>Pageviews</th><th>Únicos</th></tr>{linhas}</table>
<p style="opacity:.6;font-size:12px">Contador zera se o servidor reiniciar (plano free).</p></body></html>'''
    return html


def safipay_headers(idempotency_key=None):
    cid = os.environ.get('SAFIPAY_CLIENT_ID', '').strip()
    cs = os.environ.get('SAFIPAY_CLIENT_SECRET', '').strip()
    if not cid or not cs:
        raise RuntimeError('SafiPay nao configurada no servidor.')
    h = {'Accept': 'application/json', 'Content-Type': 'application/json', 'ci': cid, 'cs': cs}
    if idempotency_key:
        h['Idempotency-Key'] = idempotency_key
    return h


def safipay_api(method, path, body=None, idem=None):
    r = requests.request(method, SAFIPAY_BASE + path, headers=safipay_headers(idem),
                         json=body, timeout=25, allow_redirects=False)
    try:
        payload = r.json()
    except ValueError:
        payload = {}
    if r.status_code >= 400:
        code = payload.get('code') if isinstance(payload, dict) else None
        log.warning('SafiPay HTTP %s %s code=%s', r.status_code, path.split('?')[0], code)
        raise RuntimeError(f'SafiPay recusou a operacao (HTTP {r.status_code}).')
    data = payload.get('data') if isinstance(payload, dict) else None
    if payload.get('success') is not True or not isinstance(data, dict):
        raise RuntimeError('Resposta invalida da SafiPay.')
    return data


def load_orders():
    try:
        with open(ORDERS_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_orders(orders):
    tmp = ORDERS_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(orders, f, ensure_ascii=False)
    os.replace(tmp, ORDERS_FILE)


def load_exportacao():
    path = os.path.join(SITE_DIR, 'exportacao.json')
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def qr_data_url(code):
    img = qrcode.make(code)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def brl_to_float(s):
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).strip().replace('R$', '').replace('.', '').replace(',', '.').strip()
    return float(s)


@app.post('/api/pagamento/criar')
def criar():
    data = request.get_json(silent=True) or {}
    placa = re.sub(r'[^A-Za-z0-9]', '', str(data.get('placa', ''))).upper()
    itens = data.get('itens')
    email = str(data.get('email', '')).strip()[:140]
    if not placa or not isinstance(itens, list) or not itens:
        return jsonify(ok=False, message='Dados do pedido invalidos.'), 400

    # Valida itens contra o exportacao.json do site (nao confia no valor do cliente)
    try:
        exp = load_exportacao()
    except Exception:
        return jsonify(ok=False, message='Base de dados indisponivel.'), 503
    reg = None
    if isinstance(exp, list):
        for r in exp:
            if re.sub(r'[^A-Za-z0-9]', '', str(r.get('placa', ''))).upper() == placa:
                reg = r
                break
    elif isinstance(exp, dict):
        reg = exp.get('placas', {}).get(placa)
    if reg is None:
        return jsonify(ok=False, message='Placa nao encontrada.'), 404
    pend = reg.get('pendencias', [])

    selecionados = []
    total = 0.0
    for it in itens:
        idx = it.get('idx')
        if not isinstance(idx, int) or idx < 0 or idx >= len(pend):
            return jsonify(ok=False, message='Item invalido.'), 400
        p = pend[idx]
        valor = brl_to_float(p.get('valor', 0))
        if valor <= 0:
            continue
        selecionados.append({'idx': idx, 'ticket_code': p.get('ticket_code'), 'valor': valor})
        total += valor
    total = round(total, 2)
    if total <= 0:
        return jsonify(ok=False, message='Nenhum item com valor selecionado.'), 400
    if total > 5000:
        return jsonify(ok=False, message='Valor acima do limite permitido.'), 400

    ext_ref = 'placa-' + placa + '-' + str(int(time.time()))
    idem = re.sub(r'[^A-Za-z0-9:_-]', '', ext_ref)[:128]
    payload = {
        'amount': total,
        'description': f'Pedagio eletronico - placa {placa}',
        'payerName': f'Placa {placa}',
        'externalReference': ext_ref,
    }
    try:
        result = safipay_api('POST', '/pix-create', payload, idem=idem)
    except Exception as e:
        log.exception('pix-create falhou')
        return jsonify(ok=False, message=str(e)), 502

    tid = result.get('transactionId')
    copia = result.get('copyPaste')
    if not isinstance(tid, str) or not re.fullmatch(r'sfp_[A-Za-z0-9_-]{1,124}', tid):
        return jsonify(ok=False, message='Resposta da SafiPay incompleta.'), 502

    order = {
        'id': ext_ref, 'placa': placa, 'email': email, 'itens': selecionados,
        'total': total, 'transactionId': tid, 'status': 'pending',
        'created': int(time.time()), 'expiresAt': result.get('expiresAt'),
    }
    orders = load_orders()
    orders[tid] = order
    save_orders(orders)

    out = {'ok': True, 'transactionId': tid, 'status': result.get('status', 'pending'),
           'expiresAt': result.get('expiresAt'), 'valor': total}
    if isinstance(copia, str) and copia:
        out['copia_cola'] = copia
        try:
            out['qr'] = qr_data_url(copia)
        except Exception:
            pass
    return jsonify(out)


@app.get('/api/pagamento/status')
def status():
    tid = request.args.get('transactionId', '')
    if not re.fullmatch(r'sfp_[A-Za-z0-9_-]{1,124}', tid):
        return jsonify(ok=False, message='Transacao invalida.'), 400
    try:
        result = safipay_api('GET', '/pix-status?transactionId=' + tid)
    except Exception as e:
        return jsonify(ok=False, message=str(e)), 502
    st = result.get('status')
    orders = load_orders()
    if tid in orders:
        orders[tid]['status'] = st
        orders[tid]['safipay'] = {k: result.get(k) for k in ('fee', 'netAmount', 'paidAt') if k in result}
        save_orders(orders)
    return jsonify(ok=True, status=st, transactionId=tid)


def valid_webhook(raw, headers):
    secret = os.environ.get('SAFIPAY_WEBHOOK_SECRET', '')
    if not secret:
        return False
    try:
        parts = {}
        for part in headers.get('X-SafiPay-Signature-V2', '').split(','):
            k, v = part.strip().split('=', 1)
            parts.setdefault(k, []).append(v)
        ts = parts['t'][0]
        if not re.fullmatch(r'\d{1,12}', ts) or abs(time.time() - int(ts)) > 300:
            return False
        expected = hmac.new(secret.encode(), ts.encode() + b'.' + raw, hashlib.sha256).hexdigest()
        return any(hmac.compare_digest(expected, v) for v in parts.get('v1', []) if re.fullmatch(r'[a-f0-9]{64}', v))
    except (ValueError, KeyError):
        return False


@app.post('/api/webhooks/safipay')
def webhook():
    raw = request.get_data()
    if not valid_webhook(raw, request.headers):
        return jsonify(received=False), 401
    try:
        payload = json.loads(raw)
        event = payload.get('event')
        tid = (payload.get('data') or {}).get('transactionId')
    except Exception:
        return jsonify(received=False), 400
    line = json.dumps({'ts': int(time.time()), 'event': event, 'transactionId': tid}, ensure_ascii=False)
    try:
        with open(WEBHOOK_LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass
    if tid and tid in load_orders():
        orders = load_orders()
        orders[tid]['webhook_event'] = event
        orders[tid]['status'] = 'paid' if event == 'pix.paid' else orders[tid].get('status')
        save_orders(orders)
    return jsonify(received=True), 200


# ---------- site estatico ----------

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def static_files(path):
    if path.startswith('api/'):
        abort(404)
    if path == '':
        path = 'index.html'
    full = os.path.join(SITE_DIR, path)
    if os.path.isdir(full):
        full = os.path.join(full, 'index.html')
    if not os.path.isfile(full):
        abort(404)
    return send_from_directory(SITE_DIR, path)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
