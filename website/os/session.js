(function () {
  var desk = document.getElementById('desktop');
  var hold = document.getElementById('session-hold');
  if (desk) desk.hidden = true;

  function leave() {
    window.location.replace('/');
  }

  function show(user, level) {
    document.body.dataset.session = 'in';
    var email = document.getElementById('account-email');
    var badge = document.getElementById('account-level');
    if (email) email.textContent = user.email || '';
    if (badge) badge.textContent = level;
    if (hold) hold.hidden = true;
    if (desk) desk.hidden = false;
    window.dispatchEvent(new Event('valhalla-signed-in'));
  }

  if (!window.ValhallaSupabase || !window.ValhallaSupabase.config()) {
    leave();
    return;
  }

  window.ValhallaSupabase.client().then(function (supabase) {
    return supabase.auth.getSession().then(function (result) {
      var session = result && result.data && result.data.session;
      var user = session && session.user;
      if (!user || !user.id) {
        leave();
        return;
      }
      show(user, 'Free');
      var signOut = document.getElementById('sign-out');
      if (signOut) {
        signOut.hidden = false;
        signOut.addEventListener('click', function () {
          supabase.auth.signOut().then(function () { leave(); }, leave);
        });
      }
      return supabase.from('profiles').select('account_level').eq('id', user.id).maybeSingle().then(function (row) {
        var badge = document.getElementById('account-level');
        if (!badge || !row || row.error || !row.data) return;
        badge.textContent = window.ValhallaSupabase.levelLabel(row.data.account_level);
      }, function () {});
    });
  }).catch(leave);
})();
