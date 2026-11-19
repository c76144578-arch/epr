
const PLACA_RE = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
const norm = v => v.toUpperCase().replace(/[^A-Z0-9]/g,'');
const brl = v => Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
function dtBR(s){
  if(!s) return '-';
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3]+'/'+m[2]+'/'+m[1] : s;
}
const ICO = {
  concessionaria: 'assets/images/icons/highway.svg',
  praca: 'assets/images/icons/localizacao.svg',
  data: 'assets/images/icons/data_passagem.svg',
  valor: 'assets/images/icons/pagamento.svg'
};

let DADOS = null, PLACA_ATUAL = null;
fetch('exportacao.json').then(r=>r.json()).then(d=>{ DADOS=d; }).catch(()=>{ DADOS=[]; });

function bindCheck(inputId, boxId){
  const inp = document.getElementById(inputId), box = document.getElementById(boxId);
  inp.addEventListener('change', ()=> box.classList.toggle('checked', inp.checked));
}
bindCheck('cbEstrangeira','boxEstrangeira');
bindCheck('cbTermos','boxTermos');

document.getElementById('formConsulta').addEventListener('submit', e=>{
  e.preventDefault();
  const placa = norm(document.getElementById('inputPlaca').value);
  const inp = document.getElementById('inputPlaca');
  const erro = document.getElementById('erroPlaca');

  if(!PLACA_RE.test(placa)){
    inp.classList.add('red-input');
    erro.textContent = 'Insira um valor de placa válido.';
    return;
  }
  inp.classList.remove('red-input');
  erro.textContent = '';
  if(!DADOS){ erro.textContent='Base de dados não carregada. Tente novamente.'; return; }

  PLACA_ATUAL = placa;
  const item = DADOS.find(x=>x.placa===placa);
  renderResultados(item);
});

function renderResultados(item){
  document.getElementById('viewBusca').style.display='none';
  const view = document.getElementById('viewResultado');
  view.style.display='block';

  if(!item){
    view.innerHTML =
      '<h1>PASSAGENS</h1>'+
      '<div class="empty-state">'+
        '<img src="assets/images/icons/icone_nenhuma_pendencia.svg">'+
        '<p>Não existem pendências para essa placa no momento.</p>'+
      '</div>'+
      '<div class="res-actions"><button class="btn-back" onclick="voltarBusca()">VOLTAR</button></div>';
    return;
  }

  let html = '<h1>PASSAGENS</h1><div class="ticket-list">';
  item.pendencias.forEach((p,idx)=>{
    const emRevisao = (p.highway_status||p.status||'')==='IN_REVIEW';
    html += '<div class="ticket" data-idx="'+idx+'">';
    html += '<div class="head"><span class="ident">Identificador: '+(p.ticket_code||'-')+'</span>'+
            '<span class="custom-checkbox sel-box"></span></div>';
    if(p.concessionaria)
      html += '<div class="linha"><img src="'+ICO.concessionaria+'"><span class="txt">'+p.concessionaria+'</span></div>';
    html += '<div class="linha"><img src="'+ICO.praca+'"><span class="txt">'+(p.praca||'-')+'</span></div>';
    html += '<div class="linha"><img src="'+ICO.data+'"><span class="txt">'+dtBR(p.data_passagem)+'</span></div>';
    if(emRevisao){
      html += '<span class="status-chip">'+(p.status_titulo||'EM REVISÃO')+'</span>';
    } else {
      html += '<div class="linha"><img src="'+ICO.valor+'"><span class="txt valor">'+brl(p.valor)+'</span></div>';
    }
    html += '</div>';
  });
  html += '</div>';
  html += '<div class="total-area"><h4>Valor total:</h4><h3 id="valorTotal"></h3></div>';
  html += '<div class="res-actions">'+
          '<button class="btn-next" id="btnProximo">PRÓXIMO</button>'+
          '<button class="btn-back" onclick="voltarBusca()">VOLTAR</button></div>'+
          '<div class="msg" id="msgRes"></div>';
  view.innerHTML = html;

  const lista = view.querySelector('.ticket-list');
  lista.querySelectorAll('.ticket').forEach(t=>{
    t.addEventListener('click', ()=>{
      t.querySelector('.sel-box').classList.toggle('checked');
      atualizarTotal(item);
    });
  });
  atualizarTotal(item);

  view.querySelector('#btnProximo').addEventListener('click', ()=>{
    const marc = view.querySelectorAll('.ticket .sel-box.checked');
    const msg = view.querySelector('#msgRes');
    if(marc.length===0){ msg.textContent='Selecione ao menos uma pendência para continuar.'; return; }
    msg.textContent='Pagamento indisponível nesta versão de demonstração.';
  });
}

function atualizarTotal(item){
  const view = document.getElementById('viewResultado');
  const marc = view.querySelectorAll('.ticket .sel-box.checked');
  let total = 0;
  marc.forEach(b=>{ total += Number(item.pendencias[+b.closest('.ticket').dataset.idx].valor)||0; });
  if(marc.length===0) total = item.pendencias.reduce((a,p)=>a+(Number(p.valor)||0),0);
  view.querySelector('#valorTotal').textContent = brl(total);
}

function voltarBusca(){
  document.getElementById('viewResultado').style.display='none';
  document.getElementById('viewResultado').innerHTML='';
  document.getElementById('viewBusca').style.display='flex';
}
