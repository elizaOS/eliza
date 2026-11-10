(function () {
  var form = document.getElementById('ai-form');
  var status = document.getElementById('ai-status');
  if (!form || !status) return;

  var busy = false;

  function show(text, state) {
    status.textContent = text;
    var badge = document.getElementById('ai-state');
    if (badge) badge.textContent = state;
  }

  function secretLike(text) {
    var words = text.trim().toLowerCase().split(/\s+/);
    return (words.length >= 12 && words.length <= 24 && words.every(function (word) { return /^[a-z]+$/.test(word); })) || /[1-9A-HJ-NP-Za-km-z]{64,}/.test(text);
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (busy) return;
    var input = document.getElementById('ai-input');
    var button = form.querySelector('button');
    var text = input && input.value ? input.value.trim() : '';
    var reply = document.getElementById('ai-reply');
    if (!text) return;
    if (secretLike(text)) {
      show('Do not share a seed phrase or private key. Your message was not sent.', 'NOT CONNECTED');
      return;
    }
    if (!document.body || document.body.dataset.session !== 'in' || !window.ValhallaSupabase) {
      show('Sign-in required.', 'NOT CONNECTED');
      return;
    }
    busy = true;
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    if (reply) reply.textContent = '';
    try {
      var supabase = await window.ValhallaSupabase.client();
      var session = await supabase.auth.getSession();
      var token = session && session.data && session.data.session && session.data.session.access_token;
      if (!token) {
        show('Sign-in required.', 'NOT CONNECTED');
        return;
      }
      var response = await fetch('/api/ai', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
        cache: 'no-store'
      });
      if (response.status === 503) {
        show('Assistant not connected', 'NOT CONNECTED');
        return;
      }
      if (response.status === 401) {
        show('Sign-in required.', 'NOT CONNECTED');
        return;
      }
      if (response.status === 429) {
        show('Too many assistant requests. Wait a minute.', 'NOT CONNECTED');
        return;
      }
      var body = {};
      try { body = await response.json(); } catch (error) { body = {}; }
      if (!response.ok || typeof body.reply !== 'string' || !body.reply.trim()) {
        show('Assistant not connected', 'NOT CONNECTED');
        return;
      }
      if (reply) reply.textContent = body.reply;
      show('Reply received. Not financial advice.', 'CONNECTED');
    } catch (error) {
      show('Assistant not connected', 'NOT CONNECTED');
    } finally {
      busy = false;
      if (input) input.disabled = false;
      if (button) button.disabled = false;
    }
  });
})();
