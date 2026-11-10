(function () {
  var status = document.getElementById('feed-status');
  if (!status) return;

  function fail() {
    status.textContent = 'Feed not connected';
    var state = document.getElementById('feed-state');
    if (state) state.textContent = 'NOT CONNECTED';
    var list = document.getElementById('feed-list');
    if (list) list.replaceChildren();
  }

  function line(text) {
    var item = document.createElement('li');
    item.textContent = text;
    return item;
  }

  var generation = 0;

  async function load() {
    var mine = ++generation;
    function current() { return mine === generation; }
    if (!document.body || document.body.dataset.session !== 'in' || !window.ValhallaSupabase) {
      if (current()) fail();
      return;
    }
    try {
      var supabase = await window.ValhallaSupabase.client();
      var session = await supabase.auth.getSession();
      if (!current()) return;
      var token = session && session.data && session.data.session && session.data.session.access_token;
      if (!token) {
        fail();
        return;
      }
      var wallet = document.body.dataset.wallet || '';
      var response = await fetch('/api/feed' + (wallet ? '?wallet=' + encodeURIComponent(wallet) : ''), {
        headers: { authorization: 'Bearer ' + token },
        cache: 'no-store'
      });
      if (!current()) return;
      if (!response.ok) {
        fail();
        return;
      }
      var body = await response.json();
      if (!current()) return;
      var list = document.getElementById('feed-list');
      if (list) list.replaceChildren();
      var any = false;
      if (typeof body.solPriceUsd === 'number') {
        any = true;
        if (list) list.appendChild(line('SOL ' + body.solPriceUsd + ' USD'));
      }
      var activity = Array.isArray(body.valosActivity) ? body.valosActivity : [];
      if (activity.length) {
        any = true;
        activity.forEach(function (row) {
          if (list) list.appendChild(line((row.type || 'Event') + ' ' + String(row.signature || '').slice(0, 8)));
        });
      }
      if (body.wallet) {
        if (typeof body.wallet.sol === 'number') {
          any = true;
          if (list) list.appendChild(line(body.wallet.sol + ' SOL'));
        }
        if (typeof body.wallet.valos === 'number') {
          any = true;
          if (list) list.appendChild(line(body.wallet.valos + ' valOS'));
        }
      }
      if (!any) {
        fail();
        return;
      }
      status.textContent = 'Live feed';
      var state = document.getElementById('feed-state');
      if (state) state.textContent = 'CONNECTED';
    } catch (error) {
      if (current()) fail();
    }
  }

  window.addEventListener('valhalla-signed-in', function () { return load(); });
  window.addEventListener('valhalla-wallet-changed', function () { return load(); });
})();
