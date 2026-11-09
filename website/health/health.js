(function () {
  'use strict';
  var LABELS = { 'supabase': 'Supabase database', 'upstash-redis': 'Upstash Redis cache', 'elizaos': 'elizaOS agents' };
  var STATUS_CLASS = { up: 'pill-ok', ok: 'pill-ok', down: 'pill-bad', degraded: 'pill-bad', partial: 'pill-warn', not_configured: 'pill-warn', disabled: 'pill-ok', enabled: 'pill-bad' };
  var STATUS_TEXT = { up: 'Up', ok: 'All systems operational', down: 'Down', degraded: 'Degraded', partial: 'Partially configured', not_configured: 'Not configured', disabled: 'Disabled', enabled: 'Enabled' };

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pill(status) {
    return el('span', 'pill ' + (STATUS_CLASS[status] || 'pill-wait'), STATUS_TEXT[status] || status);
  }

  function card(title, status, lines) {
    var c = el('article', 'card');
    var h = el('h3', null, title);
    h.appendChild(pill(status));
    c.appendChild(h);
    lines.forEach(function (l) { c.appendChild(el('p', 'muted', l)); });
    return c;
  }

  function render(data) {
    var overall = document.getElementById('overall');
    overall.className = 'pill ' + (STATUS_CLASS[data.status] || 'pill-wait');
    overall.textContent = STATUS_TEXT[data.status] || data.status;
    document.getElementById('meta').textContent =
      'Mode: ' + data.mode + ' · checked ' + new Date(data.checkedAt).toLocaleTimeString();

    var systems = document.getElementById('systems');
    systems.replaceChildren();
    data.checks.forEach(function (c) {
      var lines = [];
      if (c.latencyMs != null) lines.push('Latency ' + c.latencyMs + ' ms');
      if (c.error) lines.push('Error: ' + c.error);
      if (c.status === 'not_configured') lines.push('Set the server-side secrets to enable.');
      systems.appendChild(card(LABELS[c.name] || c.name, c.status, lines));
    });

    var safety = document.getElementById('safety');
    safety.replaceChildren();
    [['Trading', data.safety.trading], ['Social posting', data.safety.social], ['Key storage', data.safety.keyStorage]]
      .forEach(function (s) { safety.appendChild(card(s[0], s[1], [])); });
    safety.appendChild(card('Owner access', data.safety.adminConfigured ? 'up' : 'not_configured', []));
  }

  function renderError(msg) {
    var overall = document.getElementById('overall');
    overall.className = 'pill pill-bad';
    overall.textContent = 'Unreachable';
    document.getElementById('meta').textContent = msg;
  }

  function load() {
    fetch('/api/health', { cache: 'no-store' })
      .then(function (r) {
        // 503 still carries a valid degraded snapshot
        return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
      })
      .then(function (res) {
        if (res.body && res.body.checks) render(res.body);
        else renderError('Health endpoint returned ' + res.status + '.');
      })
      .catch(function () { renderError('Could not reach /api/health.'); });
  }

  document.getElementById('refresh').addEventListener('click', load);
  load();
  setInterval(load, 30000);
})();
