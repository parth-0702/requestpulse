/* RequestPulse dashboard. Runs inside a VS Code webview; talks to the extension through postMessage.
 * Everything is built with DOM APIs (textContent, never innerHTML) so URLs and labels can never inject markup. */
(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------------ DOM helpers

  function applyProps(el, props) {
    if (!props) { return; }
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === undefined || v === null || v === false) { return; }
      if (k === 'text') { el.textContent = v; }
      else if (k === 'value') { el.value = v; }
      else if (k === 'checked') { el.checked = !!v; }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') { el.addEventListener(k.slice(2).toLowerCase(), v); }
      else { el.setAttribute(k, v === true ? '' : String(v)); }
    });
  }
  function append(el, kids) {
    kids.forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) { return; }
      if (Array.isArray(kid)) { append(el, kid); }
      else if (typeof kid === 'string' || typeof kid === 'number') { el.appendChild(document.createTextNode(String(kid))); }
      else { el.appendChild(kid); }
    });
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    applyProps(el, props);
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }
  function s(tag, props) {
    var el = document.createElementNS(SVG_NS, tag);
    applyProps(el, props);
    append(el, Array.prototype.slice.call(arguments, 2));
    return el;
  }
  function clear(el) { while (el.firstChild) { el.removeChild(el.firstChild); } }

  // ------------------------------------------------------------------ formatting

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtInt(n) { return isNum(n) ? Math.round(n).toLocaleString('en-US') : '—'; }
  function fmtNum(n, d) {
    if (!isNum(n)) { return '—'; }
    return n.toLocaleString('en-US', { maximumFractionDigits: d === undefined ? 2 : d });
  }
  function fmtMs(v) {
    if (!isNum(v)) { return '—'; }
    if (v >= 1000) { return (v / 1000).toFixed(2) + ' s'; }
    if (v >= 100) { return Math.round(v) + ' ms'; }
    return v.toFixed(v < 10 ? 1 : 0) + ' ms';
  }
  function fmtPct(v) { return isNum(v) ? fmtNum(v, 2) + '%' : '—'; }
  function fmtDuration(sec) {
    if (!isNum(sec)) { return '—'; }
    if (sec < 60) { return sec + ' s'; }
    var m = Math.floor(sec / 60), r = Math.round(sec % 60);
    if (m >= 60) { var hr = Math.floor(m / 60); return hr + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); }
    return m + ' min' + (r ? ' ' + r + ' s' : '');
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), r = sec % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }
  function trafficText(cfg, plan) {
    if (cfg.mode === 'total') {
      return fmtInt(cfg.totalRequests) + ' requests spread over ' + fmtDuration(cfg.durationSec) + ' (' + fmtNum(plan ? plan.targetRps : 0, 2) + ' requests/second)';
    }
    return fmtNum(cfg.rate, 2) + ' requests/second for ' + fmtDuration(cfg.durationSec);
  }
  function titleOf(r) {
    return r.label ? r.label : r.config.method + ' ' + r.config.url;
  }
  function isLoopback(hostname) {
    var hn = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
    return hn === 'localhost' || /\.localhost$/.test(hn) || hn === '::1' || /^127\.\d+\.\d+\.\d+$/.test(hn);
  }

  // ------------------------------------------------------------------ state

  var state = {
    tab: 'run',
    k6: null,
    run: { phase: 'idle', elapsedSec: 0, durationSec: 0 },
    platform: '',
    limits: null,
    history: [],
    current: null,
    selBefore: null,
    selAfter: null,
    cmp: { before: null, after: null },
    wantCompare: false,
  };
  var ui = {};

  // ------------------------------------------------------------------ layout

  function buildLayout() {
    var app = document.getElementById('app');
    clear(app);

    ui.k6Badge = h('span', { class: 'badge' });
    ui.noticeHost = h('div', { 'aria-live': 'polite' });
    ui.k6Banner = h('div');

    ui.tabRun = h('button', { class: 'tab', role: 'tab', id: 'tab-run', text: 'Run a test', onclick: function () { showTab('run'); } });
    ui.tabHistory = h('button', { class: 'tab', role: 'tab', id: 'tab-history', text: 'History & compare', onclick: function () { showTab('history'); vscode.postMessage({ type: 'refreshHistory' }); } });

    ui.runView = h('div', { role: 'tabpanel', 'aria-labelledby': 'tab-run' });
    ui.historyView = h('div', { role: 'tabpanel', 'aria-labelledby': 'tab-history' });

    app.appendChild(h('div', { class: 'header' },
      h('div', null, h('h1', { text: 'RequestPulse' }), h('p', { class: 'tagline', text: 'Send controlled traffic to an endpoint and see how it holds up.' })),
      ui.k6Badge));
    app.appendChild(ui.noticeHost);
    app.appendChild(ui.k6Banner);
    app.appendChild(h('div', { class: 'tabs', role: 'tablist' }, ui.tabRun, ui.tabHistory));
    app.appendChild(ui.runView);
    app.appendChild(ui.historyView);

    buildRunView();
    showTab('run');
  }

  function showTab(tab) {
    state.tab = tab;
    ui.tabRun.setAttribute('aria-selected', String(tab === 'run'));
    ui.tabHistory.setAttribute('aria-selected', String(tab === 'history'));
    ui.runView.classList.toggle('hidden', tab !== 'run');
    ui.historyView.classList.toggle('hidden', tab !== 'history');
    if (tab === 'history') { renderHistory(); }
  }

  // ------------------------------------------------------------------ notices & k6 banner

  function showNotice(level, text, actions) {
    clear(ui.noticeHost);
    if (!text) { return; }
    var box = h('div', { class: 'notice ' + level, role: level === 'error' ? 'alert' : 'status' },
      h('div', { class: 'body' }, h('div', { text: text }), actions ? h('div', { class: 'actions' }, actions) : null),
      h('button', { class: 'x', 'aria-label': 'Dismiss', text: '×', onclick: function () { clear(ui.noticeHost); } }));
    ui.noticeHost.appendChild(box);
  }

  function renderK6() {
    var k6 = state.k6;
    clear(ui.k6Banner);
    clear(ui.k6Badge);
    if (!k6) {
      ui.k6Badge.className = 'badge';
      ui.k6Badge.textContent = 'Checking for k6…';
    } else if (k6.ok) {
      ui.k6Badge.className = 'badge ok';
      ui.k6Badge.textContent = '✓ k6 ' + k6.version + ' ready';
    } else {
      ui.k6Badge.className = 'badge bad';
      ui.k6Badge.textContent = '✗ k6 not found';
      var cmd = null, alt = null;
      if (state.platform === 'win32') { cmd = 'winget install k6 --source winget'; alt = 'choco install k6'; }
      else if (state.platform === 'darwin') { cmd = 'brew install k6'; }
      ui.k6Banner.appendChild(h('div', { class: 'notice warn', role: 'alert' },
        h('div', { class: 'body' },
          h('strong', { text: 'RequestPulse needs k6 to generate traffic.' }),
          h('p', { class: 'small', text: (k6.error || 'k6 is not installed.') + ' k6 is a free, open-source load-testing tool that RequestPulse runs for you.' }),
          cmd ? h('div', { class: 'cmd-row' }, h('span', { text: 'Install with:' }), h('code', { class: 'cmd', text: cmd }),
            h('button', { class: 'btn secondary', text: 'Copy', onclick: function () { vscode.postMessage({ type: 'copyText', text: cmd }); } })) : null,
          alt ? h('p', { class: 'small muted', text: 'or with Chocolatey: ' + alt }) : null,
          h('p', { class: 'small muted', text: 'After installing, restart VS Code (so it sees the new PATH), then click Re-check. If k6 is installed somewhere unusual, set "requestpulse.k6Path" in Settings.' }),
          h('div', { class: 'actions' },
            h('button', { class: 'btn', text: 'Open install guide', onclick: function () { vscode.postMessage({ type: 'openK6Docs' }); } }),
            h('button', { class: 'btn secondary', text: 'Re-check', onclick: function () { vscode.postMessage({ type: 'recheckK6' }); } })))));
    }
    updateRunControls();
  }

  // ------------------------------------------------------------------ run view: form

  var f = {};

  function field(label, input, hint, cls) {
    var id = input.id;
    return h('div', { class: 'field' + (cls ? ' ' + cls : '') },
      h('label', { for: id, text: label }), input, hint ? h('span', { class: 'hint', id: id + '-hint', text: hint }) : null);
  }
  function numberInput(id, min, max, step) {
    return h('input', { type: 'number', id: id, min: min, max: max, step: step, inputmode: 'decimal' });
  }

  function buildRunView() {
    f.label = h('input', { type: 'text', id: 'f-label', maxlength: 60, placeholder: 'e.g. Before caching', autocomplete: 'off' });
    f.url = h('input', { type: 'text', id: 'f-url', placeholder: 'http://localhost:3000/api/products', autocomplete: 'off', spellcheck: 'false' });
    f.method = h('select', { id: 'f-method' }, h('option', { value: 'GET', text: 'GET' }), h('option', { value: 'HEAD', text: 'HEAD' }));
    f.modeRate = h('input', { type: 'radio', name: 'mode', id: 'f-mode-rate', value: 'rate', onchange: updateDerived });
    f.modeTotal = h('input', { type: 'radio', name: 'mode', id: 'f-mode-total', value: 'total', onchange: updateDerived });
    f.rate = numberInput('f-rate', 0.1, 500, 'any');
    f.total = numberInput('f-total', 1, 100000, 1);
    f.duration = numberInput('f-duration', 5, 3600, 1);
    f.p95 = numberInput('f-p95', 1, 600000, 1);
    f.err = numberInput('f-err', 0, 100, 'any');
    f.timeout = numberInput('f-timeout', 1, 60, 1);
    f.permission = h('input', { type: 'checkbox', id: 'f-permission' });

    f.rateField = field('Requests per second', f.rate, 'Average traffic rate, spread evenly. One person browsing can cause several requests.');
    f.totalField = field('Total requests', f.total, 'Spread evenly over the duration (not sent all at once).');
    f.permissionBox = h('div', { class: 'permission field wide hidden' },
      h('label', { class: 'check', for: 'f-permission' }, f.permission,
        h('span', null, h('strong', { text: 'I own this site or have permission to load-test it.' }),
          h('br'), h('span', { class: 'hint', text: 'Load tests add real traffic to a live service and may breach your host’s terms or use up free-tier quotas.' }))));

    f.summary = h('div', { class: 'summary-line wide field', 'aria-live': 'polite' });
    f.errors = h('ul', { class: 'errors', role: 'alert' });
    f.errorsWrap = h('div', { class: 'wide field hidden' }, f.errors);

    var chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Duration presets' });
    [30, 60, 120, 300].forEach(function (sec) {
      chips.appendChild(h('button', { type: 'button', class: 'chip', text: fmtDuration(sec), onclick: function () { f.duration.value = sec; updateDerived(); } }));
    });

    f.startBtn = h('button', { class: 'btn', type: 'button', id: 'start-btn', text: 'Start test', onclick: onStart });
    f.fields = h('fieldset', { class: 'form-grid' },
      h('div', { class: 'field wide' }, h('label', { for: 'f-url', text: 'URL to test' }), f.url,
        h('span', { class: 'hint', text: 'A local app (http://localhost:3000/…) or a deployed one (https://your-app.vercel.app/…, https://your-api.onrender.com/…). It must be running.' })),
      field('Name this run (optional)', f.label, 'Shown in your history, e.g. “Before caching”.'),
      field('Request method', f.method, 'One request per scheduled tick; redirects are not followed.'),
      h('div', { class: 'field wide' },
        h('fieldset', null,
          h('legend', { text: 'How should traffic be described?' }),
          h('div', { class: 'radios' },
            h('label', null, f.modeRate, ' Requests per second'),
            h('label', null, f.modeTotal, ' Total requests over the duration')))),
      f.rateField, f.totalField,
      h('div', { class: 'field' }, h('label', { for: 'f-duration', text: 'Duration (seconds)' }), f.duration, chips),
      field('Request timeout (seconds)', f.timeout, 'A request with no response by then counts as failed.'),
      field('p95 response-time target (ms)', f.p95, '95% of requests should finish within this time.'),
      field('Error-rate target (%)', f.err, 'At most this share of requests may fail.'),
      f.summary, f.permissionBox, f.errorsWrap);

    f.stopBtn = h('button', { class: 'btn danger', type: 'button', text: 'Stop test', onclick: function () { vscode.postMessage({ type: 'stop' }); } });
    f.runTitle = h('strong');
    f.runDetail = h('span', { class: 'muted' });
    f.bar = h('div');
    f.runCard = h('div', { class: 'card hidden', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'btn-row' }, f.runTitle, f.runDetail),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, f.bar),
      h('div', { class: 'btn-row' }, f.stopBtn,
        h('span', { class: 'hint', text: 'Stopping keeps the results gathered so far.' })));

    ui.resultHost = h('div');

    ui.runView.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Configure a test' }),
      f.fields,
      h('div', { class: 'btn-row', style: null }, f.startBtn,
        h('span', { class: 'hint', text: 'Start small (the defaults are modest) and only test systems you own or have permission to test.' }))));
    ui.runView.appendChild(f.runCard);
    ui.runView.appendChild(ui.resultHost);

    ['input', 'change'].forEach(function (evt) {
      [f.url, f.rate, f.total, f.duration, f.timeout, f.p95, f.err].forEach(function (el) { el.addEventListener(evt, updateDerived); });
    });
    renderEmptyResult();
  }

  function fillForm(c) {
    f.label.value = c.label || '';
    f.url.value = c.url || '';
    f.method.value = c.method === 'HEAD' ? 'HEAD' : 'GET';
    f.modeRate.checked = c.mode !== 'total';
    f.modeTotal.checked = c.mode === 'total';
    f.rate.value = c.rate !== undefined ? c.rate : 10;
    f.total.value = c.totalRequests !== undefined ? c.totalRequests : 600;
    f.duration.value = c.durationSec;
    f.p95.value = c.p95TargetMs;
    f.err.value = c.errorRateTargetPct;
    f.timeout.value = c.timeoutSec;
    f.permission.checked = false;
    updateDerived();
  }

  function readForm() {
    return {
      label: f.label.value,
      url: f.url.value,
      method: f.method.value,
      mode: f.modeTotal.checked ? 'total' : 'rate',
      rate: f.rate.value,
      totalRequests: f.total.value,
      durationSec: f.duration.value,
      p95TargetMs: f.p95.value,
      errorRateTargetPct: f.err.value,
      timeoutSec: f.timeout.value,
      confirmedPermission: f.permission.checked,
    };
  }

  function updateDerived() {
    var totalMode = f.modeTotal.checked;
    f.rateField.classList.toggle('hidden', totalMode);
    f.totalField.classList.toggle('hidden', !totalMode);

    var dur = Number(f.duration.value);
    var rps = totalMode ? Number(f.total.value) / dur : Number(f.rate.value);
    var planned = totalMode ? Number(f.total.value) : Number(f.rate.value) * dur;
    var text = '';
    if (isFinite(rps) && isFinite(planned) && dur > 0 && rps > 0) {
      text = totalMode
        ? fmtInt(planned) + ' requests over ' + fmtDuration(dur) + ' averages ' + fmtNum(rps, 2) + ' requests/second.'
        : 'About ' + fmtInt(planned) + ' requests in total (' + fmtNum(rps, 2) + ' per second for ' + fmtDuration(dur) + ').';
      text += ' The report shows the traffic actually achieved, because this computer may not keep up.';
      if (rps > 100) { text += ' That is heavy for a single computer or a free hosting plan; consider starting lower.'; }
    }
    clear(f.summary);
    f.summary.classList.toggle('hidden', !text);
    f.summary.textContent = text;

    var remote = false;
    try {
      var u = new URL(f.url.value.trim());
      remote = (u.protocol === 'http:' || u.protocol === 'https:') && !isLoopback(u.hostname);
    } catch (e) { remote = false; }
    f.permissionBox.classList.toggle('hidden', !remote);
    if (!remote) { f.permission.checked = false; }
  }

  function showValidation(errors) {
    clear(f.errors);
    errors.forEach(function (e) { f.errors.appendChild(h('li', { text: e })); });
    f.errorsWrap.classList.toggle('hidden', errors.length === 0);
    if (errors.length) { f.errorsWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  function onStart() {
    clear(ui.noticeHost);
    showValidation([]);
    vscode.postMessage({ type: 'start', config: readForm() });
  }

  function updateRunControls() {
    var phase = state.run.phase;
    var active = phase !== 'idle';
    f.fields.disabled = active;
    var k6ok = state.k6 && state.k6.ok;
    f.startBtn.disabled = active || (state.k6 !== null && !k6ok);
    f.startBtn.title = state.k6 !== null && !k6ok ? 'Install k6 first (see the notice above).' : '';
    f.runCard.classList.toggle('hidden', !active);
    if (!active) { return; }

    var r = state.run;
    var pct = r.durationSec > 0 ? Math.min(100, (r.elapsedSec / r.durationSec) * 100) : 0;
    f.stopBtn.disabled = phase === 'stopping' || phase === 'processing';
    if (phase === 'starting') {
      f.runTitle.textContent = 'Starting k6…';
      f.runDetail.textContent = 'Preparing virtual users.';
      pct = 0;
    } else if (phase === 'running') {
      f.runTitle.textContent = 'Sending traffic';
      f.runDetail.textContent = fmtClock(r.elapsedSec) + ' of ' + fmtClock(r.durationSec) + (r.url ? ' → ' + r.url : '');
    } else if (phase === 'stopping') {
      f.runTitle.textContent = 'Stopping…';
      f.runDetail.textContent = 'Collecting the results gathered so far.';
    } else {
      f.runTitle.textContent = 'Processing results…';
      f.runDetail.textContent = 'Building your report.';
      pct = 100;
    }
    f.bar.style.width = pct + '%';
    f.runCard.querySelector('.progress').setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  // ------------------------------------------------------------------ charts

  function niceStep(range, ticks) {
    if (!(range > 0)) { return 1; }
    var raw = range / ticks;
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return mult * mag;
  }

  /** opts: {title, ariaLabel, series:[{name, cls, dashed, pts:[[x,y|null]...], fmt}], refs:[{y,label,cls}], yFormat, xFormat, yTitle} */
  function lineChart(opts) {
    var W = 640, H = 250, L = 58, R = 14, T = 14, B = 34;
    var PW = W - L - R, PH = H - T - B;

    var xMax = 1, yMax = 0;
    opts.series.forEach(function (se) {
      se.pts.forEach(function (p) {
        if (p[0] > xMax) { xMax = p[0]; }
        if (isNum(p[1]) && p[1] > yMax) { yMax = p[1]; }
      });
    });
    (opts.refs || []).forEach(function (r) { if (isNum(r.y) && r.y > yMax) { yMax = r.y; } });
    if (!(yMax > 0)) { yMax = 1; }
    var yStep = niceStep(yMax, 4);
    var yTop = Math.ceil((yMax * 1.05) / yStep) * yStep;
    var xStep = niceStep(xMax, 6);
    var xTop = Math.max(xStep, Math.ceil(xMax / xStep) * xStep);
    if (xMax <= 1) { xTop = 1; xStep = 1; }

    function X(v) { return L + (v / xTop) * PW; }
    function Y(v) { return T + PH - (v / yTop) * PH; }

    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.ariaLabel || opts.title });
    var v, i;
    for (v = 0; v <= yTop + yStep / 2; v += yStep) {
      svg.appendChild(s('line', { class: 'grid', x1: L, x2: W - R, y1: Y(v), y2: Y(v) }));
      svg.appendChild(s('text', { class: 'axis-label', x: L - 8, y: Y(v) + 4, 'text-anchor': 'end', text: opts.yFormat(v) }));
    }
    for (v = 0; v <= xTop + xStep / 2; v += xStep) {
      svg.appendChild(s('line', { class: 'grid', x1: X(v), x2: X(v), y1: T + PH, y2: T + PH + 4 }));
      svg.appendChild(s('text', { class: 'axis-label', x: X(v), y: T + PH + 18, 'text-anchor': 'middle', text: (opts.xFormat || fmtClock)(v) }));
    }
    svg.appendChild(s('text', { class: 'axis-title', x: L + PW / 2, y: H - 3, 'text-anchor': 'middle', text: 'Time since the first response (min:sec)' }));

    (opts.refs || []).forEach(function (r) {
      if (!isNum(r.y)) { return; }
      svg.appendChild(s('line', { class: 'ref ' + r.cls, x1: L, x2: W - R, y1: Y(r.y), y2: Y(r.y) }));
      svg.appendChild(s('text', { class: 'ref-label ' + r.cls, x: W - R - 2, y: Y(r.y) - 5, 'text-anchor': 'end', text: r.label }));
    });

    opts.series.forEach(function (se) {
      var d = '', pen = false, count = 0;
      se.pts.forEach(function (p) {
        if (!isNum(p[1])) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1) + ' ';
        pen = true;
        count++;
      });
      if (d) { svg.appendChild(s('path', { class: 'line ' + se.cls + (se.dashed ? ' dashed' : ''), d: d })); }
      if (count <= 40) {
        se.pts.forEach(function (p) {
          if (isNum(p[1])) { svg.appendChild(s('circle', { class: 'dot ' + se.cls, cx: X(p[0]), cy: Y(p[1]), r: 2.8 })); }
        });
      }
    });

    var wrap = h('div', { class: 'chart' });
    var tip = h('div', { class: 'tip hidden', 'aria-hidden': 'true' });
    var cursor = s('line', { class: 'cursor hidden', y1: T, y2: T + PH });
    var overlay = s('rect', { x: L, y: T, width: PW, height: PH, fill: 'transparent' });
    svg.appendChild(cursor);
    svg.appendChild(overlay);

    overlay.addEventListener('pointermove', function (ev) {
      var box = svg.getBoundingClientRect();
      if (!box.width) { return; }
      var xv = ((((ev.clientX - box.left) * W) / box.width) - L) / PW * xTop;
      var rows = [], snapX = null, best = Infinity;
      opts.series.forEach(function (se) {
        var near = null, dist = Infinity;
        se.pts.forEach(function (p) {
          var dd = Math.abs(p[0] - xv);
          if (dd < dist) { dist = dd; near = p; }
        });
        if (near && dist < best) { best = dist; snapX = near[0]; }
      });
      if (snapX === null) { return; }
      opts.series.forEach(function (se) {
        var hit = null;
        se.pts.forEach(function (p) { if (p[0] === snapX) { hit = p; } });
        if (hit && isNum(hit[1])) { rows.push(h('div', { text: se.name + ': ' + (se.fmt || opts.yFormat)(hit[1]) })); }
      });
      clear(tip);
      tip.appendChild(h('div', { class: 't', text: fmtClock(snapX) + ' into the test' }));
      rows.forEach(function (r) { tip.appendChild(r); });
      cursor.setAttribute('x1', X(snapX)); cursor.setAttribute('x2', X(snapX));
      cursor.classList.remove('hidden');
      tip.classList.remove('hidden');
      var wb = wrap.getBoundingClientRect();
      var left = ev.clientX - wb.left + 14;
      if (left + tip.offsetWidth > wb.width) { left = ev.clientX - wb.left - tip.offsetWidth - 14; }
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = Math.max(0, ev.clientY - wb.top - 10) + 'px';
    });
    overlay.addEventListener('pointerleave', function () { cursor.classList.add('hidden'); tip.classList.add('hidden'); });

    var legend = h('div', { class: 'legend' });
    opts.series.concat((opts.refs || []).map(function (r) { return { name: r.label, cls: r.cls, dashed: true }; })).forEach(function (se) {
      legend.appendChild(h('span', { class: se.cls },
        s('svg', { viewBox: '0 0 26 8', 'aria-hidden': 'true' }, s('line', { class: 'sw', x1: 1, x2: 25, y1: 4, y2: 4, 'stroke-width': 2.5, 'stroke-dasharray': se.dashed ? '6 4' : null })),
        se.name));
    });

    wrap.appendChild(h('h3', { text: opts.title }));
    wrap.appendChild(svg);
    wrap.appendChild(tip);
    wrap.appendChild(legend);
    return wrap;
  }

  function yAxisMs(v) { return v >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + ' s' : Math.round(v * 10) / 10 + ' ms'; }
  function yAxisRps(v) { return (Math.round(v * 100) / 100).toString(); }

  function pts(series, key) { return series.map(function (p) { return [p.t, p[key]]; }); }

  // ------------------------------------------------------------------ results

  function renderEmptyResult() {
    clear(ui.resultHost);
    ui.resultHost.appendChild(h('div', { class: 'card empty' },
      h('p', { text: 'No result yet.' }),
      h('p', { class: 'small', text: 'Start your application, enter its URL above, and click Start test. Your report appears here, and every run is saved to History.' })));
  }

  function tile(label, value, sub, cls) {
    return h('div', { class: 'tile' }, h('div', { class: 'k', text: label }), h('div', { class: 'v ' + (cls || ''), text: value }), sub ? h('div', { class: 's', text: sub }) : null);
  }

  function checkItem(ok, text) {
    return h('li', { class: ok ? 'pass-t' : 'fail-t' }, (ok ? '✓ ' : '✗ ') + text);
  }

  function renderResult(r) {
    state.current = r;
    clear(ui.resultHost);
    var sum = r.summary, ver = r.verdict, lat = sum.latency, cfg = r.config;

    var verdictText, verdictSub, vcls;
    if (ver.overall === 'pass') { verdictText = '✓ All targets met'; verdictSub = 'Under this traffic, the endpoint met both your response-time and error-rate targets.'; vcls = 'pass'; }
    else if (ver.overall === 'fail') { verdictText = '✗ Targets missed'; verdictSub = 'At least one of your targets was not met during this test.'; vcls = 'fail'; }
    else { verdictText = '! Inconclusive'; verdictSub = r.status === 'completed' ? 'The targets were met, but the requested traffic was not fully delivered.' : 'The test did not run to completion, so it cannot be judged fully.'; vcls = 'incomplete'; }

    var statusLabel = r.status === 'completed' ? 'Completed' : r.status === 'stopped' ? 'Stopped early' : 'Ended unexpectedly';

    ui.resultHost.appendChild(h('div', { class: 'card' },
      h('div', { class: 'result-head' },
        h('div', null, h('h2', null, titleOf(r), h('span', { class: 'chipstat', text: statusLabel })),
          h('div', { class: 'muted small', text: fmtDate(r.startedAt) + ' · ' + trafficText(cfg, r.plan) })),
        h('button', { class: 'btn secondary', text: 'Open History', onclick: function () { showTab('history'); vscode.postMessage({ type: 'refreshHistory' }); } })),
      h('div', { class: 'verdict ' + vcls, role: 'status' }, h('div', null, h('div', { text: verdictText }), h('div', { class: 'sub', text: verdictSub }))),
      h('ul', { class: 'checks' },
        checkItem(ver.p95.passed, 'p95 response time ' + fmtMs(ver.p95.actual) + ' (target ≤ ' + fmtMs(ver.p95.target) + ')'),
        checkItem(ver.errorRate.passed, 'Error rate ' + fmtPct(ver.errorRate.actual) + ' (target ≤ ' + fmtPct(ver.errorRate.target) + ')'),
        h('li', { class: ver.generatorKeptUp ? 'pass-t' : 'warn-t' }, (ver.generatorKeptUp ? '✓ ' : '! ') + (ver.generatorKeptUp ? 'Requested traffic delivered' : 'Requested traffic not fully delivered'))),
      h('div', { class: 'tiles' },
        tile('Requests sent', fmtInt(sum.totalRequests), 'of ' + fmtInt(sum.plannedRequests) + ' planned'),
        tile('Achieved rate', fmtNum(sum.achievedRps, 2) + '/s', 'target ' + fmtNum(sum.targetRps, 2) + '/s', ver.generatorKeptUp ? '' : 'warn-t'),
        tile('Median response', lat ? fmtMs(lat.p50) : '—'),
        tile('p95 response', lat ? fmtMs(lat.p95) : '—', 'target ≤ ' + fmtMs(cfg.p95TargetMs), ver.p95.passed ? 'pass-t' : 'fail-t'),
        tile('Slowest 1% (p99)', lat ? fmtMs(lat.p99) : '—', lat ? 'max ' + fmtMs(lat.max) : ''),
        tile('Failed requests', fmtInt(sum.failedRequests), fmtPct(sum.errorRatePct) + ' · target ≤ ' + fmtPct(cfg.errorRateTargetPct), ver.errorRate.passed ? 'pass-t' : 'fail-t'))));

    // What this means
    var icons = { good: '✓', warn: '!', bad: '✗', info: 'i' };
    var labels = { good: 'Good: ', warn: 'Warning: ', bad: 'Problem: ', info: 'Note: ' };
    var list = h('ul', { class: 'insights' });
    (r.insights || []).forEach(function (ins) {
      list.appendChild(h('li', { class: ins.level },
        h('span', { class: 'ic', 'aria-hidden': 'true', text: icons[ins.level] || 'i' }),
        h('span', null, h('span', { class: 'sr-only', text: labels[ins.level] || '' }), ins.text)));
    });
    ui.resultHost.appendChild(h('div', { class: 'card' }, h('h2', { text: 'What this means' }), list));

    // Charts
    if (r.series && r.series.length) {
      var tput = [{ name: 'Completed requests/s', cls: 'c-blue', pts: pts(r.series, 'rps') }];
      if (sum.failedRequests > 0) { tput.push({ name: 'Failed requests/s', cls: 'c-red', dashed: true, pts: pts(r.series, 'failedRps') }); }
      var latSeries = [
        { name: 'Median (p50)', cls: 'c-green', pts: pts(r.series, 'p50'), fmt: fmtMs },
        { name: 'p95', cls: 'c-orange', pts: pts(r.series, 'p95'), fmt: fmtMs },
      ];
      var chartsRow = h('div', { class: 'charts' },
        lineChart({
          title: 'Traffic over time', ariaLabel: 'Line chart of completed requests per second over the test', series: tput,
          refs: [{ y: sum.targetRps, label: 'Target ' + fmtNum(sum.targetRps, 2) + '/s', cls: 'c-purple' }], yFormat: yAxisRps,
        }),
        lineChart({
          title: 'Response time over time', ariaLabel: 'Line chart of median and 95th percentile response time over the test', series: latSeries,
          refs: [{ y: cfg.p95TargetMs, label: 'p95 target ' + fmtMs(cfg.p95TargetMs), cls: 'c-red' }], yFormat: yAxisMs,
        }));
      var bucketNote = r.bucketSec > 1 ? 'Each point summarises ' + r.bucketSec + ' seconds.' : 'Each point summarises one second.';
      ui.resultHost.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Charts' }), chartsRow, h('p', { class: 'hint', text: bucketNote + ' Hover a chart for exact values.' })));
    }

    // Details tables
    var pctTable = h('table', null,
      h('thead', null, h('tr', null, h('th', { text: 'Response time' }), h('th', { class: 'num', text: 'Value' }))),
      h('tbody', null, lat ? [
        ['Fastest', lat.min], ['Average', lat.avg], ['Median (p50)', lat.p50], ['p90', lat.p90], ['p95', lat.p95], ['p99', lat.p99], ['Slowest', lat.max],
      ].map(function (row) { return h('tr', null, h('td', { text: row[0] }), h('td', { class: 'num', text: fmtMs(row[1]) })); }) :
        h('tr', null, h('td', { colspan: 2, class: 'muted', text: 'No request received a response.' }))));

    var codes = Object.keys(sum.statusCodes || {}).sort(function (a, b) { return sum.statusCodes[b] - sum.statusCodes[a]; });
    var total = sum.totalRequests || 1;
    var codeBody = h('tbody');
    codes.forEach(function (code) {
      var n = sum.statusCodes[code];
      var bad = code === '0' || Number(code) >= 400;
      var name = code === '0' ? 'No response (timeout or connection error)' : code;
      var bar = h('div', { class: 'bar' + (bad ? ' err' : '') });
      bar.style.width = Math.max(1, (n / total) * 100) + '%';
      codeBody.appendChild(h('tr', null, h('td', { text: name }), h('td', { class: 'num', text: fmtInt(n) }), h('td', { class: 'bar-cell' }, bar)));
    });
    var codeTable = h('table', null, h('thead', null, h('tr', null, h('th', { text: 'HTTP status' }), h('th', { class: 'num', text: 'Requests' }), h('th', { text: '' }))), codeBody);

    ui.resultHost.appendChild(h('div', { class: 'card' },
      h('div', { class: 'two-col' },
        h('div', { class: 'table-wrap' }, pctTable, lat ? h('p', { class: 'hint', text: 'Based on ' + fmtInt(lat.samples) + ' requests that got a response or timed out.' }) : null),
        h('div', { class: 'table-wrap' }, codeTable))));

    var targets = 'p95 ≤ ' + fmtMs(cfg.p95TargetMs) + ', errors ≤ ' + fmtPct(cfg.errorRateTargetPct);
    ui.resultHost.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Test details' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'URL' }), h('dd', { class: 'mono', text: cfg.method + ' ' + cfg.url }),
        h('dt', { text: 'Traffic' }), h('dd', { text: trafficText(cfg, r.plan) }),
        h('dt', { text: 'Timeout' }), h('dd', { text: cfg.timeoutSec + ' s per request' }),
        h('dt', { text: 'Targets' }), h('dd', { text: targets }),
        h('dt', { text: 'Measured over' }), h('dd', { text: fmtNum(sum.measuredSec, 1) + ' s' }),
        h('dt', { text: 'Started' }), h('dd', { text: fmtDate(r.startedAt) }),
        h('dt', { text: 'Generator' }), h('dd', { text: 'k6 ' + (r.k6Version || '(unknown version)') + ', run from this computer' }),
        h('dt', { text: 'Result id' }), h('dd', { class: 'mono muted', text: r.id })),
      h('p', { class: 'hint', text: 'These figures describe this endpoint under this traffic from this computer during this test. They are not the absolute capacity of the site, and they cannot show server CPU or memory use.' })));
  }

  // ------------------------------------------------------------------ history & compare

  function renderHistory() {
    var host = ui.historyView;
    clear(host);

    if (!state.history.length) {
      host.appendChild(h('div', { class: 'card empty' },
        h('p', { text: 'No saved tests yet.' }),
        h('p', { class: 'small', text: 'Every completed or stopped test is saved on this computer. Run one, change your app, run the same settings again, then compare them here.' })));
      return;
    }

    var tbody = h('tbody');
    state.history.forEach(function (it) {
      var overall = it.overall === 'pass' ? ['✓ Pass', 'pass-t'] : it.overall === 'fail' ? ['✗ Missed', 'fail-t'] : ['! Incomplete', 'warn-t'];
      var name = it.label || (it.method + ' ' + it.url);
      tbody.appendChild(h('tr', null,
        h('td', { class: 'pick' }, h('input', { type: 'radio', name: 'before', value: it.id, checked: state.selBefore === it.id, 'aria-label': 'Use as before: ' + name, onchange: function () { state.selBefore = it.id; updateCompareButton(); } })),
        h('td', { class: 'pick' }, h('input', { type: 'radio', name: 'after', value: it.id, checked: state.selAfter === it.id, 'aria-label': 'Use as after: ' + name, onchange: function () { state.selAfter = it.id; updateCompareButton(); } })),
        h('td', null, h('div', { text: name }), h('div', { class: 'muted small', text: fmtDate(it.createdAt) + (it.label ? ' · ' + it.url : '') })),
        h('td', { text: fmtNum(it.targetRps, 2) + '/s × ' + fmtDuration(it.durationSec) }),
        h('td', { class: 'num', text: fmtNum(it.achievedRps, 2) + '/s' }),
        h('td', { class: 'num', text: fmtMs(it.p95) }),
        h('td', { class: 'num', text: fmtPct(it.errorRatePct) }),
        h('td', { class: overall[1], text: overall[0] }),
        h('td', null, h('div', { class: 'btn-row' },
          h('button', { class: 'btn secondary', text: 'View', onclick: function () { vscode.postMessage({ type: 'getResult', id: it.id, purpose: 'view' }); } }),
          h('button', { class: 'btn secondary', text: 'Delete', onclick: function () { vscode.postMessage({ type: 'deleteResult', id: it.id }); } })))));
    });

    ui.compareBtn = h('button', { class: 'btn', text: 'Compare', onclick: onCompare });
    host.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Saved tests' }),
      h('p', { class: 'hint', text: 'Pick one run as “Before” and another as “After”, then compare. For a fair comparison, use the same URL, traffic and duration.' }),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null,
          h('th', { class: 'pick', text: 'Before' }), h('th', { class: 'pick', text: 'After' }), h('th', { text: 'Test' }), h('th', { text: 'Traffic' }),
          h('th', { class: 'num', text: 'Achieved' }), h('th', { class: 'num', text: 'p95' }), h('th', { class: 'num', text: 'Errors' }), h('th', { text: 'Verdict' }), h('th', { text: '' }))),
        tbody)),
      h('div', { class: 'btn-row' }, ui.compareBtn,
        h('button', { class: 'btn secondary', text: 'Open reports folder', onclick: function () { vscode.postMessage({ type: 'openReportsFolder' }); } }),
        h('span', { class: 'hint', text: 'Results are stored only on this computer.' }))));

    ui.compareHost = h('div');
    host.appendChild(ui.compareHost);
    updateCompareButton();
    if (state.cmp.before && state.cmp.after) { renderCompare(); }
  }

  function updateCompareButton() {
    if (!ui.compareBtn) { return; }
    var ok = state.selBefore && state.selAfter && state.selBefore !== state.selAfter;
    ui.compareBtn.disabled = !ok;
    ui.compareBtn.title = ok ? '' : 'Choose two different tests: one Before, one After.';
  }

  function onCompare() {
    state.cmp = { before: null, after: null };
    state.wantCompare = true;
    vscode.postMessage({ type: 'getResult', id: state.selBefore, purpose: 'before' });
    vscode.postMessage({ type: 'getResult', id: state.selAfter, purpose: 'after' });
  }

  function metricRow(label, a, b, fmt, lowerIsBetter, neutral) {
    var after;
    if (!isNum(a) || !isNum(b)) {
      after = h('td', { class: 'same', text: '—' });
    } else {
      var diff = b - a;
      var rel = a !== 0 ? Math.abs(diff) / Math.abs(a) : (diff === 0 ? 0 : 1);
      var cls = 'same', word = 'about the same';
      if (!neutral && rel >= 0.05) {
        var better = lowerIsBetter ? diff < 0 : diff > 0;
        cls = better ? 'better' : 'worse';
        word = better ? 'better' : 'worse';
      } else if (neutral && rel >= 0.05) { word = diff > 0 ? 'higher' : 'lower'; }
      var arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '=';
      var pct = a !== 0 ? ' ' + Math.abs(diff / a * 100).toFixed(rel < 0.1 ? 1 : 0) + '%' : '';
      after = h('td', { class: cls, text: arrow + pct + ' · ' + word });
    }
    return h('tr', null, h('td', { text: label }), h('td', { class: 'num', text: fmt(a) }), h('td', { class: 'num', text: fmt(b) }), after);
  }

  function renderCompare() {
    if (!ui.compareHost) { return; }
    clear(ui.compareHost);
    var A = state.cmp.before, B = state.cmp.after;
    if (!A || !B) { return; }
    var la = A.summary.latency, lb = B.summary.latency;
    function lv(l, k) { return l ? l[k] : null; }

    // Are the settings comparable?
    var diffs = [];
    if (A.config.url !== B.config.url) { diffs.push('URL'); }
    if (A.config.method !== B.config.method) { diffs.push('method'); }
    if (Math.abs(A.summary.targetRps - B.summary.targetRps) > 0.001) { diffs.push('target request rate'); }
    if (A.config.durationSec !== B.config.durationSec) { diffs.push('duration'); }
    if (A.status !== 'completed' || B.status !== 'completed') { diffs.push('completion (one run was stopped early)'); }

    // Plain-language headline
    var bits = [];
    if (la && lb && la.p95 > 0) {
      var change = (lb.p95 - la.p95) / la.p95 * 100;
      if (Math.abs(change) >= 5) { bits.push('p95 response time ' + (change < 0 ? 'improved by ' : 'got worse by ') + Math.abs(change).toFixed(0) + '% (' + fmtMs(la.p95) + ' → ' + fmtMs(lb.p95) + ')'); }
      else { bits.push('p95 response time is about the same (' + fmtMs(la.p95) + ' → ' + fmtMs(lb.p95) + ')'); }
    }
    if (A.summary.errorRatePct !== B.summary.errorRatePct) {
      bits.push('the error rate went from ' + fmtPct(A.summary.errorRatePct) + ' to ' + fmtPct(B.summary.errorRatePct));
    } else { bits.push('the error rate stayed at ' + fmtPct(A.summary.errorRatePct)); }
    var headline = bits.length ? bits[0].charAt(0).toUpperCase() + bits[0].slice(1) + (bits.length > 1 ? '; ' + bits.slice(1).join('; ') : '') + '.' : '';

    var nameA = 'Before: ' + titleOf(A), nameB = 'After: ' + titleOf(B);
    var table = h('table', null,
      h('thead', null, h('tr', null, h('th', { text: 'Metric' }), h('th', { class: 'num', text: 'Before' }), h('th', { class: 'num', text: 'After' }), h('th', { text: 'Change' }))),
      h('tbody', null,
        metricRow('Requests sent', A.summary.totalRequests, B.summary.totalRequests, fmtInt, false, true),
        metricRow('Achieved requests/second', A.summary.achievedRps, B.summary.achievedRps, function (v) { return isNum(v) ? fmtNum(v, 2) : '—'; }, false, true),
        metricRow('Median response time', lv(la, 'p50'), lv(lb, 'p50'), fmtMs, true),
        metricRow('Average response time', lv(la, 'avg'), lv(lb, 'avg'), fmtMs, true),
        metricRow('p95 response time', lv(la, 'p95'), lv(lb, 'p95'), fmtMs, true),
        metricRow('p99 response time', lv(la, 'p99'), lv(lb, 'p99'), fmtMs, true),
        metricRow('Slowest response', lv(la, 'max'), lv(lb, 'max'), fmtMs, true),
        metricRow('Error rate', A.summary.errorRatePct, B.summary.errorRatePct, fmtPct, true),
        metricRow('Failed requests', A.summary.failedRequests, B.summary.failedRequests, fmtInt, true)));

    var charts = h('div', { class: 'charts' },
      lineChart({
        title: 'p95 response time over time', ariaLabel: 'Line chart comparing p95 response time of the two runs',
        series: [{ name: 'Before', cls: 'c-orange', dashed: true, pts: pts(A.series, 'p95'), fmt: fmtMs }, { name: 'After', cls: 'c-blue', pts: pts(B.series, 'p95'), fmt: fmtMs }],
        yFormat: yAxisMs,
      }),
      lineChart({
        title: 'Requests per second over time', ariaLabel: 'Line chart comparing completed requests per second of the two runs',
        series: [{ name: 'Before', cls: 'c-orange', dashed: true, pts: pts(A.series, 'rps') }, { name: 'After', cls: 'c-blue', pts: pts(B.series, 'rps') }],
        yFormat: yAxisRps,
      }));

    ui.compareHost.appendChild(h('div', { class: 'card' },
      h('h2', { text: 'Before vs after' }),
      h('p', { class: 'muted small', text: nameA + '  →  ' + nameB }),
      diffs.length ? h('div', { class: 'notice warn' }, h('div', { class: 'body', text: 'These runs differ in: ' + diffs.join(', ') + '. Part of any change may come from that rather than from changes to your application.' })) : null,
      headline ? h('p', { class: 'summary-line', text: headline }) : null,
      h('div', { class: 'table-wrap' }, table),
      h('div', { style: 'margin-top:18px' }, charts),
      h('p', { class: 'hint', text: 'Differences under about 5% are shown as “about the same”: repeated runs of the same test normally vary by a few percent.' })));
    ui.compareHost.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ------------------------------------------------------------------ messages from the extension

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || typeof m !== 'object') { return; }
    switch (m.type) {
      case 'init':
        state.platform = m.platform || '';
        state.limits = m.limits || null;
        state.k6 = m.k6 || null;
        state.run = m.run || state.run;
        state.history = m.history || [];
        fillForm(m.defaults);
        renderK6();
        updateRunControls();
        if (state.history.length && !state.current) { /* leave the empty state; history tab has the list */ }
        break;
      case 'k6Status':
        state.k6 = m.status;
        renderK6();
        break;
      case 'runState':
        state.run = m.run;
        updateRunControls();
        break;
      case 'validationErrors':
        showValidation(m.errors || []);
        break;
      case 'notice':
        showNotice(m.level || 'info', m.text);
        break;
      case 'result':
        showTab('run');
        renderResult(m.result);
        ui.resultHost.scrollIntoView({ block: 'start', behavior: 'smooth' });
        break;
      case 'history':
        state.history = m.items || [];
        var ids = {};
        state.history.forEach(function (it) { ids[it.id] = true; });
        if (state.selBefore && !ids[state.selBefore]) { state.selBefore = null; }
        if (state.selAfter && !ids[state.selAfter]) { state.selAfter = null; }
        if (state.cmp.before && !ids[state.cmp.before.id]) { state.cmp.before = null; }
        if (state.cmp.after && !ids[state.cmp.after.id]) { state.cmp.after = null; }
        if (state.tab === 'history') { renderHistory(); }
        break;
      case 'resultData':
        if (!m.result) { showNotice('warn', 'That saved result could not be read. It may have been moved or edited.'); break; }
        if (m.purpose === 'view') { showTab('run'); renderResult(m.result); ui.resultHost.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
        else if (m.purpose === 'before') { state.cmp.before = m.result; }
        else if (m.purpose === 'after') { state.cmp.after = m.result; }
        if (state.wantCompare && state.cmp.before && state.cmp.after) { state.wantCompare = false; renderCompare(); }
        break;
    }
  });

  buildLayout();
  renderK6();
  vscode.postMessage({ type: 'ready' });
})();
