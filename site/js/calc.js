;(function ($) {
  'use strict';

  const localizedData = typeof calculadoraTarifasData !== 'undefined'
    ? calculadoraTarifasData
    : {};

  const config = localizedData.calculatorConfig || {};
  const DBT_DISCOUNT = Number(config.dbtDiscount || 0.95);
  const MAX_DISCOUNT_TRIPS = Number(config.maxDiscountTrips || 30);
  const MAX_TRIPS = MAX_DISCOUNT_TRIPS;
  let CURVA_FIXA = config.fixedCurves || {};
  let tabelaBase = config.baseTolls || {};
  let tabelaBaseExibicao = config.displayBaseTolls || {};
  const pduByPpCode = config.pduByPpCode || {};
  const catMultiplier = config.categoryMultiplier || {};
  const discountBaseCat = config.discountBaseCategory || {};
  const MOCK_PEDAGIOS = Array.isArray(config.mockPedagios) && config.mockPedagios.length
    ? config.mockPedagios
    : [
        {
          pp_code: 'PP05',
          calculator_key: 'pp1',
          calculator_title: 'PP05 - Pórtico Pedágio Eletrônico Pres. Castelo Branco'
        },
        {
          pp_code: 'PP06',
          calculator_key: 'pp2',
          calculator_title: 'PP06 - Pórtico Pedágio Eletrônico Mandaguari'
        },
        {
          pp_code: 'PP07',
          calculator_key: 'pp3',
          calculator_title: 'PP07 - Pórtico Pedágio Eletrônico Arapongas / Rolândia'
        },
        {
          pp_code: 'PP08',
          calculator_key: 'pp4',
          calculator_title: 'PP08 - Pórtico Pedágio Eletrônico Jataizinho'
        }
      ];

  function roundCurrency(value) {
    return Math.round((Number(value) + 1e-9) * 100) / 100;
  }

  function normalizeTripCount(rawValue) {
    const parsedValue = parseInt(rawValue, 10);
    return Number.isNaN(parsedValue) ? 0 : parsedValue;
  }

  function clampTripCount(value) {
    return Math.min(MAX_TRIPS, Math.max(1, normalizeTripCount(value) || 1));
  }

  function syncTripControls(value) {
    $('#incrementViagens').prop('disabled', value >= MAX_TRIPS);
  }

  function getTarifaBase(categoria, pracaKey) {
    const categoryTable = tabelaBase[categoria];
    return categoryTable && categoryTable[pracaKey]
      ? Number(categoryTable[pracaKey])
      : 0;
  }

  function getTarifaBaseExibicao(categoria, pracaKey) {
    const categoryTable = tabelaBaseExibicao[categoria];
    if (categoryTable && categoryTable[pracaKey]) {
      return Number(categoryTable[pracaKey]);
    }

    return getTarifaBase(categoria, pracaKey);
  }

  function getCurve(pracaKey) {
    return Array.isArray(CURVA_FIXA[pracaKey]) ? CURVA_FIXA[pracaKey] : [];
  }

  function getPedagioOrder(ppCode) {
    const match = String(ppCode || '').match(/PP(\d+)/i);
    return match ? parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  function normalizePedagiosForCalculator(tolls) {
    const groupedPedagios = new Map();

    (Array.isArray(tolls) ? tolls : []).forEach((toll) => {
      const calculatorKey = String(toll && toll.calculator_key ? toll.calculator_key : '').trim();
      const calculatorTitle = String(toll && toll.calculator_title ? toll.calculator_title : '').trim();

      if (!calculatorKey || !calculatorTitle) {
        return;
      }

      const ppCode = String(toll && toll.pp_code ? toll.pp_code : '').trim();
      const groupKey = calculatorKey || ppCode;

      if (!groupedPedagios.has(groupKey)) {
        groupedPedagios.set(groupKey, {
          value: calculatorKey,
          title: calculatorTitle,
          ppCode
        });
      }
    });

    return Array.from(groupedPedagios.values()).sort((left, right) => {
      const orderDiff = getPedagioOrder(left.ppCode) - getPedagioOrder(right.ppCode);
      if (orderDiff !== 0) {
        return orderDiff;
      }

      return left.title.localeCompare(right.title, 'pt-BR');
    });
  }

  function getCurveIndex(tripNumber, curva) {
    if (!curva.length) {
      return -1;
    }

    const normalizedTrip = Math.max(1, normalizeTripCount(tripNumber) || 1);
    return Math.min(normalizedTrip, MAX_DISCOUNT_TRIPS) - 1;
  }

  function getCurveTripValue(pracaKey, tripNumber) {
    const curva = getCurve(pracaKey);
    const curveIndex = getCurveIndex(tripNumber, curva);
    return curveIndex >= 0 ? Number(curva[curveIndex]) : 0;
  }

  function getDiscountFactor(pracaKey, tripNumber) {
    const tarifaBaseCat1 = getTarifaBase(1, pracaKey);
    if (!tarifaBaseCat1) {
      return 0;
    }

    return getCurveTripValue(pracaKey, tripNumber) / tarifaBaseCat1;
  }

  function getValorPassagem(categoria, tripNumber, pracaKey, dbtAtivado) {
    const baseCat = discountBaseCat[categoria];
    if (baseCat === null || typeof baseCat === 'undefined') {
      return 0;
    }

    const multiplier = Number(catMultiplier[categoria] || 0);
    const baseMultiplier = Number(catMultiplier[baseCat] || 0);
    if (!multiplier || !baseMultiplier) {
      return 0;
    }

    const ratio = multiplier / baseMultiplier;
    let valor = 0;

    if (baseCat === 1) {
      valor = getCurveTripValue(pracaKey, tripNumber) * ratio;
    } else {
      const tarifaBase = getTarifaBase(baseCat, pracaKey);
      const fator = getDiscountFactor(pracaKey, tripNumber);
      valor = tarifaBase * fator * ratio;
    }

    if (!dbtAtivado) {
      valor /= DBT_DISCOUNT;
    }

    return roundCurrency(valor);
  }

  function calcularValorTotal(numPassagens, categoria, pracaKey, dbtAtivado) {
    const totalTrips = Math.max(1, normalizeTripCount(numPassagens));
    const discountedTrips = Math.min(totalTrips, MAX_DISCOUNT_TRIPS);
    let total = 0;
    let ultimo = 0;

    for (let tripNumber = 1; tripNumber <= discountedTrips; tripNumber += 1) {
      const valor = getValorPassagem(categoria, tripNumber, pracaKey, dbtAtivado);
      total += valor;
      ultimo = valor;
    }

    if (totalTrips > MAX_DISCOUNT_TRIPS) {
      const tarifaPiso = getValorPassagem(categoria, MAX_DISCOUNT_TRIPS, pracaKey, dbtAtivado);
      total += tarifaPiso * (totalTrips - MAX_DISCOUNT_TRIPS);
      ultimo = tarifaPiso;
    }

    return {
      valorTotal: roundCurrency(total),
      finalValue: roundCurrency(ultimo)
    };
  }

  function validateInputs() {
    const show = (selector, condition) => $(selector)[condition ? 'show' : 'hide']();
    const tripCount = clampTripCount($('#numeroViagens').val());
    const hasPedagio = !!$('#ppSelect').val();
    const hasCategoria = !!$('#catSelect').val();
    const hasValidTrips = tripCount >= 1 && tripCount <= MAX_TRIPS;

    show('#ppSelectError', !hasPedagio);
    show('#catSelectError', !hasCategoria);
    show('#numeroViagensError', !hasValidTrips);

    return hasPedagio && hasCategoria && hasValidTrips;
  }

  function calcular() {
    if (!validateInputs()) {
      return;
    }

    const numPassagens = clampTripCount($('#numeroViagens').val());
    const pracaKey = $('#ppSelect').val();
    const categoria = Number($('#catSelect').val());
    const dbtAtivado = $('#dbtCheck').is(':checked');
    const resultado = calcularValorTotal(numPassagens, categoria, pracaKey, dbtAtivado);
    const primeiraValue = getValorPassagem(categoria, 1, pracaKey, dbtAtivado);
    const tarifaBase = getTarifaBaseExibicao(categoria, pracaKey);
    const valorMedio = numPassagens > 0 ? resultado.valorTotal / numPassagens : 0;

    $('#tarifaBase').text(roundCurrency(tarifaBase).toFixed(2));
    $('#tarifaPrimeira').text(primeiraValue.toFixed(2));
    $('#tarifaFinal').text(resultado.finalValue.toFixed(2));
    $('#valorMedio').text(roundCurrency(valorMedio).toFixed(2));
    $('#discountMessage')[numPassagens > MAX_DISCOUNT_TRIPS ? 'show' : 'hide']();

    if (!$('#result').is(':visible')) {
      $('#result').hide().addClass('fade-in').slideDown();
    }

    syncTripControls(numPassagens);
  }

  function populatePedagios(data) {
    const $pedagios = $('#ppSelect').empty();
    const tolls = data && data.status === 0 && Array.isArray(data.tolls) && data.tolls.length
      ? data.tolls
      : MOCK_PEDAGIOS;
    applyTarifasDoJson(tolls);
    const normalizedPedagios = normalizePedagiosForCalculator(tolls);

    if (normalizedPedagios.length) {
      $pedagios.append('<option value="">Selecione o pedágio...</option>');
      normalizedPedagios.forEach((toll) => {
        $pedagios.append(`<option value="${toll.value}">${toll.title}</option>`);
      });
      return;
    }

    $pedagios.append('<option value="">Nenhuma praça encontrada</option>');
  }

  function loadPedagios() {
    const variant = String($('.calculator-container').first().data('calculator-variant') || 'default');
    const jsonUrls = localizedData.jsonUrls || {};
    const endpoint = jsonUrls[variant]
      || jsonUrls.default
      || window.location.origin + '/wp-content/dados_main/pedagios.json';

    $('#loadingSpinner').show();

    $.getJSON(endpoint)
      .done(populatePedagios)
      .fail(() => populatePedagios({ status: 0, tolls: MOCK_PEDAGIOS }))
      .always(() => $('#loadingSpinner').hide());
  }

  function applyTarifasDoJson(tolls) {
    const curvasAtualizadas = { ...CURVA_FIXA };
    const processedPedagios = new Set();
    const basesAtualizadas = { ...tabelaBase };
    const exibicaoAtualizada = { ...tabelaBaseExibicao };

    (Array.isArray(tolls) ? tolls : []).forEach((toll) => {
      const pracaKey = String(toll && toll.calculator_key ? toll.calculator_key : '').trim();
      const ppCode = String(toll && toll.pp_code ? toll.pp_code : '').trim().toUpperCase();
      const tarifaAprovada = Number(toll && toll.carro);
      const pdu = Number(pduByPpCode[ppCode]);

      if (!pracaKey || !tarifaAprovada || !pdu) {
        return;
      }

      if (processedPedagios.has(pracaKey)) {
        return;
      }

      processedPedagios.add(pracaKey);

      const tarifaComTag = tarifaAprovada * DBT_DISCOUNT;
      curvasAtualizadas[pracaKey] = Array.from(
        { length: MAX_DISCOUNT_TRIPS },
        (_, index) => roundCurrency(tarifaComTag * Math.pow(1 - pdu, index))
      );
      exibicaoAtualizada[1] = { ...(exibicaoAtualizada[1] || {}), [pracaKey]: tarifaAprovada };
      basesAtualizadas[1] = { ...(basesAtualizadas[1] || {}), [pracaKey]: tarifaAprovada };
    });

    CURVA_FIXA = curvasAtualizadas;
    tabelaBase = basesAtualizadas;
    tabelaBaseExibicao = exibicaoAtualizada;
  }

  function updateViagens(delta) {
    const currentValue = clampTripCount($('#numeroViagens').val());
    $('#numeroViagens').val(Math.min(MAX_TRIPS, Math.max(1, currentValue + delta)));
    syncTripControls(clampTripCount($('#numeroViagens').val()));
    calcular();
  }

  $('#ppSelect, #catSelect, #numeroViagens, #dbtCheck').on('change keyup input', calcular);
  $('#incrementViagens').on('click', () => updateViagens(1));
  $('#decrementViagens').on('click', () => updateViagens(-1));
  $('#numeroViagens').on('blur', function () {
    const value = clampTripCount(this.value);
    $(this).val(value);
    calcular();
  });

  $('#numeroViagens').on('input', function () {
    const value = clampTripCount(this.value);
    if (String(this.value) !== String(value)) {
      this.value = value;
    }
    syncTripControls(value);
  });

  $(document).ready(() => {
    syncTripControls(clampTripCount($('#numeroViagens').val()));
    loadPedagios();
  });
})(jQuery);
