'use strict';
(function () {
  var status = document.getElementById('wallet-status');
  var overview = document.getElementById('overview-wallet');
  var detail = document.getElementById('overview-wallet-detail');
  var disconnect = document.getElementById('wallet-disconnect');
  var walletButtons = Array.prototype.slice.call(document.querySelectorAll('[data-wallet]'));
  var active = null;
  var listeners = [];
  var busy = false;
  function removeListeners() {
    listeners.forEach(function (item) {
      if (typeof item.provider.removeListener === 'function') item.provider.removeListener(item.event, item.handler);
    });
    listeners = [];
  }
  function clearWallet(message) {
    removeListeners(); active = null;
    overview.textContent = 'Not connected';
    detail.textContent = 'Connect a wallet to view its public address.';
    status.textContent = message || 'No wallet connected.';
    disconnect.hidden = true;
  }
  function showWallet(name, address) {
    overview.textContent = name + ' connected'; detail.textContent = address;
    status.textContent = name + ' connected: ' + address; disconnect.hidden = false;
  }
  function listen(provider, event, handler) {
    if (typeof provider.on !== 'function') return;
    provider.on(event, handler); listeners.push({ provider: provider, event: event, handler: handler });
  }
  function externalProvider(name) {
    if (name === 'solflare') return window.solflare || null;
    if (name === 'phantom') {
      if (window.phantom && window.phantom.solana) return window.phantom.solana;
      if (window.solana && window.solana.isPhantom === true) return window.solana;
    }
    return null;
  }
  async function connect(name) {
    if (busy) return;
    if (name !== 'phantom' && name !== 'solflare') return;
    var provider = externalProvider(name);
    var displayName = name === 'solflare' ? 'Solflare' : 'Phantom';
    if (!provider || typeof provider.connect !== 'function') {
      status.textContent = displayName + ' was not detected. Install its browser extension, then try again.';
      return;
    }
    busy = true;
    walletButtons.forEach(function (button) { button.disabled = true; });
    status.textContent = 'Approve the connection in your wallet. No transaction or signature is requested.';
    try {
      var result = await provider.connect();
      var address = String(result && result.publicKey || provider.publicKey || '');
      if (!address) throw new Error('The wallet returned no account.');
      removeListeners(); active = { name: name, provider: provider };
      showWallet(displayName, address);
      listen(provider, 'disconnect', function () { clearWallet('Wallet disconnected.'); });
      listen(provider, 'accountChanged', function (next) {
        var value = String(next || '');
        if (value) showWallet(displayName, value); else clearWallet('Wallet account is no longer available.');
      });
    } catch (error) {
      status.textContent = 'Connection was not completed. Check your wallet and try again.';
    } finally {
      busy = false; walletButtons.forEach(function (button) { button.disabled = false; });
    }
  }
  walletButtons.forEach(function (button) { button.addEventListener('click', function () { void connect(button.dataset.wallet); }); });
  disconnect.addEventListener('click', async function () {
    var previous = active;
    if (!previous) return;
    if (typeof previous.provider.disconnect === 'function') {
      try { await previous.provider.disconnect(); }
      catch (error) { status.textContent = 'Could not disconnect the wallet. Try disconnecting in the wallet itself.'; return; }
    }
    clearWallet('Wallet disconnected.');
  });
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var log = document.getElementById('chat-log');
  var chatStatus = document.getElementById('chat-status');
  var voiceButton = document.getElementById('chat-voice');
  var history = [], submitting = false, voiceEnabled = false;
  if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') {
    voiceButton.disabled = true; voiceButton.textContent = 'Voice replies unavailable';
  }
  voiceButton.addEventListener('click', function () {
    voiceEnabled = !voiceEnabled;
    voiceButton.setAttribute('aria-pressed', String(voiceEnabled));
    voiceButton.textContent = voiceEnabled ? 'Voice replies on' : 'Voice replies off';
    if (!voiceEnabled) window.speechSynthesis.cancel();
  });
  function secretLike(text) {
    var words = text.trim().toLowerCase().split(/\s+/);
    return (words.length >= 12 && words.length <= 24 && words.every(function (word) { return /^[a-z]+$/.test(word); })) || /[1-9A-HJ-NP-Za-km-z]{64,}/.test(text);
  }
  function message(label, text) {
    var row = document.createElement('p'), author = document.createElement('strong');
    author.textContent = label; row.appendChild(author); row.appendChild(document.createElement('br'));
    row.appendChild(document.createTextNode(text)); log.appendChild(row); log.scrollTop = log.scrollHeight;
  }
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (submitting) return;
    var text = input.value.trim();
    if (!text) return;
    if (secretLike(text)) { chatStatus.textContent = 'Do not share a seed phrase or private key. Your message was not sent.'; return; }
    var base = String((window.VALHALLA_SITE || {}).CHAT_URL || '').replace(/\/+$/, '');
    if (!base) { chatStatus.textContent = 'Chat service is not configured.'; return; }
    try {
      if (new URL(base).protocol !== 'https:') throw new Error('https required');
    } catch (error) { chatStatus.textContent = 'Chat service URL is invalid. Contact support.'; return; }
    submitting = true; form.querySelector('button').disabled = true; input.disabled = true;
    message('YOU', text); input.value = ''; chatStatus.textContent = 'Waiting for the configured chat service…';
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 25000);
    try {
      var endpoint = base + '/chat';
      var response = await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text, history: history, stream: false }), signal: controller.signal
      });
      var type = response.headers.get('content-type') || '';
      if (!response.ok || type.indexOf('application/json') === -1) {
        var closed = new Error('The chat service did not return a reply.');
        closed.valhallaClosed = true;
        throw closed;
      }
      var body = await response.json();
      if (!body || body.ok === false || body.status === 'CONFIG_PENDING' || body.provider === 'valhalla-fallback') {
        var pending = new Error('Model service is not configured or unavailable. No model reply was generated.');
        pending.valhallaClosed = true;
        throw pending;
      }
      var reply = body.reply || body.content || '';
      if (typeof reply !== 'string' || !reply.trim()) {
        var empty = new Error('The chat service returned an empty reply.');
        empty.valhallaClosed = true;
        throw empty;
      }
      message('ASSISTANT', reply);
      var speechFailed = false;
      if (voiceEnabled) {
        try {
          window.speechSynthesis.cancel(); window.speechSynthesis.speak(new window.SpeechSynthesisUtterance(reply));
        } catch (error) {
          speechFailed = true; voiceEnabled = false; voiceButton.setAttribute('aria-pressed', 'false'); voiceButton.textContent = 'Voice replies off';
          chatStatus.textContent = 'Reply received, but browser speech failed. Try voice again.';
        }
      }
      history.push({ role: 'user', content: text }, { role: 'assistant', content: reply.slice(0, 500) }); history = history.slice(-8);
      if (!speechFailed) chatStatus.textContent = 'Reply received from ' + (body.provider || response.headers.get('x-valhalla-provider') || 'the configured service') + '. Not financial advice.';
    } catch (error) {
      chatStatus.textContent = error.name === 'AbortError'
        ? 'Chat timed out. No reply was generated.'
        : (error.valhallaClosed ? error.message : 'Chat service did not return a reply. Nothing was generated.');
    } finally {
      window.clearTimeout(timeout); submitting = false; form.querySelector('button').disabled = false; input.disabled = false; input.focus();
    }
  });
})();
