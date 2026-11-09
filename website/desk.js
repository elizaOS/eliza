(function (root) {
  'use strict';

  var JOURNAL_KEY = 'valhalla-paper-journal-v1';
  var LIMIT = 100;
  var MAX_BODY = 262144;
  var requests = {};
  var names = ['VALHALLA CORE', 'MECHA BRAIN', 'ASK VALHALLA', 'ODIN FEED', 'FORGE LAB', 'HEIMDALL GATE', 'SENTINEL WATCH'];

  async function getJSON(url, key) {
    if (requests[key]) requests[key].abort();
    var controller = new AbortController();
    requests[key] = controller;
    var timer = root.setTimeout(function () { controller.abort(); }, 8000);
    try {
      var response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok || !response.body || !response.body.getReader) throw new Error('Unavailable');
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var text = '', size = 0;
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY) {
          controller.abort();
          throw new Error('Response too large');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return JSON.parse(text);
    } finally {
      root.clearTimeout(timer);
      if (requests[key] === controller) delete requests[key];
    }
  }

  async function checkDeskStatus() {
    var url = String((root.VALHALLA_SITE || {}).STATUS_URL || '');
    if (!url) return { state: 'unconfigured', message: 'Status feed unconfigured; service health is unknown.' };
    try {
      var data = await getJSON(url, 'status');
      var checked = Number(data && data.checkedAt);
      if (!Number.isFinite(checked) || checked <= 0 || checked > Date.now() ||
          Date.now() - checked > 900000 || !Array.isArray(data.lines) ||
          data.lines.length !== names.length || data.lines.some(function (line, i) {
            return !line || line.name !== names[i] || ['LIVE', 'DEGRADED', 'OFFLINE'].indexOf(line.state) < 0;
          })) throw new Error('Invalid or stale status');
      var state = data.lines.some(function (line) { return line.state === 'OFFLINE'; }) ? 'OFFLINE' :
        data.lines.some(function (line) { return line.state === 'DEGRADED'; }) ? 'DEGRADED' : 'LIVE';
      return { state: state, message: 'Status feed: ' + state + ' · checked ' + new Date(checked).toLocaleString() + '. Not a guarantee of availability.' };
    } catch (error) {
      return { state: 'unavailable', message: 'Status feed unavailable or invalid; service health is unknown.' };
    }
  }

  function auditTokenAddress(value) {
    var address = String(value || '').trim();
    var valid = /^0x[0-9a-fA-F]{40}$/.test(address);
    if (!valid && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      var alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      var number = 0n;
      for (var i = 0; i < address.length; i++) number = number * 58n + BigInt(alphabet.indexOf(address[i]));
      var bytes = 0;
      while (number > 0n) { number >>= 8n; bytes++; }
      var leading = (address.match(/^1*/) || [''])[0].length;
      valid = bytes + leading === 32;
    }
    return { valid: valid, message: (valid ? 'Address syntax is valid.' : 'Invalid address syntax.') +
      ' Security audit provider unconfigured; syntax does not verify token safety.' };
  }

  async function loadPumpRadar() {
    try {
      var rows = await getJSON('https://api.dexscreener.com/token-boosts/top/v1', 'radar');
      if (!Array.isArray(rows)) throw new Error('Invalid radar response');
      var seen = Object.create(null);
      var tokens = [];
      rows.forEach(function (row) {
        var address = row && row.chainId === 'solana' && typeof row.tokenAddress === 'string' ? row.tokenAddress : '';
        if (address && !seen[address] && auditTokenAddress(address).valid && address.slice(0, 2) !== '0x' && tokens.length < 10) {
          seen[address] = true;
          tokens.push(address);
        }
      });
      return { state: 'available', tokens: tokens, message: tokens.length ? 'Top boosted Solana tokens from DexScreener.' : 'No valid boosted Solana tokens returned.' };
    } catch (error) {
      return { state: 'unavailable', tokens: [], message: 'Radar unavailable; no live feed is being shown.' };
    }
  }

  function readJournal() {
    try {
      var raw = root.localStorage.getItem(JOURNAL_KEY);
      if (!raw) return { entries: [] };
      if (raw.length > 100000) throw new Error('Journal too large');
      var entries = JSON.parse(raw);
      if (!Array.isArray(entries) || entries.length > LIMIT || entries.some(function (entry) {
        return !entry || typeof entry.token !== 'string' || entry.token.length > 80 ||
          typeof entry.at !== 'string' || entry.at.length > 40 ||
          ![entry.quantity, entry.price, entry.total].every(function (n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; });
      })) throw new Error('Invalid journal');
      return { entries: entries };
    } catch (error) {
      return { entries: [], error: 'Paper journal unavailable or invalid; it was not overwritten.' };
    }
  }

  function simulatePaperTrade(token, quantity, price) {
    token = String(token || '');
    quantity = Number(quantity);
    price = Number(price);
    var total = quantity * price;
    if (!token.trim() || token.length > 80 || !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isFinite(price) || price <= 0 || !Number.isFinite(total) || total <= 0) {
      return { error: 'Enter a token label and finite positive quantity and assumed price.' };
    }
    var journal = readJournal();
    if (journal.error) return { error: journal.error };
    var entry = { at: new Date().toISOString(), token: token, quantity: quantity, price: price, total: total };
    journal.entries.push(entry);
    journal.entries = journal.entries.slice(-LIMIT);
    try {
      root.localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal.entries));
    } catch (error) {
      return { error: 'Paper journal could not be saved; no trade was recorded.' };
    }
    return { entry: entry, entries: journal.entries };
  }

  function csvCell(value) {
    var text = String(value);
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function exportJournalCSV() {
    var journal = readJournal();
    if (journal.error) return { error: journal.error };
    var rows = [['Time (UTC)', 'Token label', 'Quantity', 'Assumed price USD', 'Simulated total USD', 'Assumed fees and slippage']];
    journal.entries.forEach(function (entry) {
      rows.push([entry.at, entry.token, entry.quantity, entry.price, entry.total, 'zero']);
    });
    return { csv: rows.map(function (row) { return row.map(csvCell).join(','); }).join('\r\n') + '\r\n' };
  }

  function boot() {
    var $ = function (id) { return document.getElementById(id); };
    if (!$('cyber-desk-title')) return;
    var generations = { status: 0, radar: 0 };
    function renderJournal(entries) {
      var list = $('desk-journal');
      list.replaceChildren();
      entries.slice(-5).reverse().forEach(function (entry) {
        var item = document.createElement('li');
        item.textContent = entry.token + ' · ' + entry.quantity + ' × $' + entry.price + ' = $' + entry.total + ' (simulated)';
        list.appendChild(item);
      });
    }
    var journal = readJournal();
    $('desk-journal-status').textContent = journal.error || 'Paper journal is stored locally (maximum 100 trades).';
    renderJournal(journal.entries);
    $('desk-status-check').addEventListener('click', async function () {
      var generation = ++generations.status;
      $('desk-status').textContent = 'Checking status feed…';
      $('desk-status-progress').hidden = false;
      var result = await checkDeskStatus();
      if (generation !== generations.status) return;
      $('desk-status-progress').hidden = true;
      $('desk-status').textContent = result.message;
    });
    $('desk-audit-form').addEventListener('submit', function (event) {
      event.preventDefault();
      $('desk-audit-result').textContent = auditTokenAddress($('desk-address').value).message;
    });
    $('desk-radar-load').addEventListener('click', async function () {
      var generation = ++generations.radar;
      $('desk-radar-status').textContent = 'Loading radar…';
      $('desk-radar-list').replaceChildren();
      $('desk-radar-progress').hidden = false;
      var result = await loadPumpRadar();
      if (generation !== generations.radar) return;
      $('desk-radar-progress').hidden = true;
      $('desk-radar-status').textContent = result.message;
      result.tokens.forEach(function (address) {
        var item = document.createElement('li');
        var badge = document.createElement('span');
        badge.className = 'cyber-badge';
        badge.textContent = 'BOOSTED';
        item.appendChild(badge);
        item.appendChild(document.createTextNode(' ' + address));
        $('desk-radar-list').appendChild(item);
      });
    });
    $('desk-paper-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var result = simulatePaperTrade($('desk-paper-token').value, $('desk-paper-amount').value, $('desk-paper-price').value);
      $('desk-paper-result').textContent = result.error || 'Simulated total: $' + result.entry.total + '. Assumed price; zero fees and slippage.';
      if (!result.error) renderJournal(result.entries);
    });
    $('desk-export').addEventListener('click', function () {
      var result = exportJournalCSV();
      if (result.error) { $('desk-journal-status').textContent = result.error; return; }
      try {
        var url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
        var link = document.createElement('a');
        link.href = url;
        link.download = 'valhalla-paper-journal.csv';
        link.click();
        root.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        $('desk-journal-status').textContent = 'Paper journal export prepared.';
      } catch (error) {
        $('desk-journal-status').textContent = 'Paper journal export unavailable.';
      }
    });
  }

  root.ValhallaDesk = { checkDeskStatus: checkDeskStatus, auditTokenAddress: auditTokenAddress,
    loadPumpRadar: loadPumpRadar, simulatePaperTrade: simulatePaperTrade, exportJournalCSV: exportJournalCSV };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : globalThis);
