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
  function ethereumProvider() {
    var ethereum = window.ethereum;
    if (!ethereum) return null;
    if (Array.isArray(ethereum.providers)) return ethereum.providers.find(function (provider) { return provider.isMetaMask === true; }) || null;
    return ethereum.isMetaMask === true ? ethereum : null;
  }
  async function connect(name) {
    if (busy) return;
    var provider = name === 'solflare' ? window.solflare : ethereumProvider();
    if (!provider) { status.textContent = (name === 'solflare' ? 'Solflare' : 'MetaMask') + ' was not detected. Install or enable its browser extension, then try again.'; return; }
    busy = true;
    walletButtons.forEach(function (button) { button.disabled = true; });
    status.textContent = 'Approve the connection in your wallet. No transaction or signature is requested.';
    try {
      var address;
      if (name === 'solflare') {
        var result = await provider.connect();
        address = String(result && result.publicKey || provider.publicKey || '');
      } else {
        var accounts = await provider.request({ method: 'eth_requestAccounts' });
        address = Array.isArray(accounts) ? String(accounts[0] || '') : '';
      }
      if (!address) throw new Error('The wallet returned no account.');
      removeListeners(); active = { name: name, provider: provider };
      var displayName = name === 'solflare' ? 'Solflare' : 'MetaMask';
      showWallet(displayName, address);
      listen(provider, 'disconnect', function () { clearWallet('Wallet disconnected.'); });
      listen(provider, name === 'solflare' ? 'accountChanged' : 'accountsChanged', function (accounts) {
        var next = name === 'solflare' ? String(accounts || '') : String(Array.isArray(accounts) && accounts[0] || '');
        if (next) showWallet(displayName, next); else clearWallet('Wallet account is no longer available.');
      });
    } catch (error) {
      status.textContent = 'Connection was not completed. ' + (error && error.code === 4001 ? 'The wallet request was declined.' : 'Check your wallet and try again.');
    } finally {
      busy = false; walletButtons.forEach(function (button) { button.disabled = false; });
    }
  }
  walletButtons.forEach(function (button) { button.addEventListener('click', function () { void connect(button.dataset.wallet); }); });
  disconnect.addEventListener('click', async function () {
    var previous = active;
    if (!previous) return;
    if (previous.name === 'solflare' && typeof previous.provider.disconnect === 'function') {
      try { await previous.provider.disconnect(); }
      catch (error) { status.textContent = 'Could not disconnect Solflare. Try disconnecting in your wallet.'; return; }
      clearWallet('Solflare disconnected.'); return;
    }
    clearWallet('Removed from this desk. To revoke access, disconnect this site in MetaMask.');
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
      var body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Chat request failed.');
      if (body.ok === false || body.status === 'CONFIG_PENDING' || body.provider === 'valhalla-fallback') throw new Error('Model service is not configured or unavailable. No model reply was generated.');
      var reply = body.reply || body.content || '';
      if (typeof reply !== 'string' || !reply.trim()) throw new Error('The chat service returned an empty reply.');
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
      chatStatus.textContent = error.name === 'AbortError' ? 'Chat timed out. Please try again.' : 'Chat: ' + (error.message || 'Please try again.');
    } finally {
      window.clearTimeout(timeout); submitting = false; form.querySelector('button').disabled = false; input.disabled = false; input.focus();
    }
  });
})();
