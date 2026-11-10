(function () {
  var status = document.getElementById('auth-status');
  var google = document.getElementById('google-sign-in');
  var form = document.getElementById('magic-link');
  var email = document.getElementById('magic-email');
  if (!status || !google || !form || !email || !window.ValhallaSupabase) return;

  var busy = false;

  function say(text) {
    status.textContent = text;
  }

  function unlock() {
    busy = false;
    google.disabled = !window.ValhallaSupabase.config();
  }

  function run(work) {
    if (busy) return;
    if (!window.ValhallaSupabase.config()) {
      say('Sign-in is not configured yet.');
      return;
    }
    busy = true;
    google.disabled = true;
    window.ValhallaSupabase.client().then(function (supabase) {
      return work(supabase);
    }).then(function () {
      unlock();
    }).catch(function (error) {
      say(window.ValhallaSupabase.providerMessage(error));
      unlock();
    });
  }

  google.addEventListener('click', function () {
    say('Opening Google…');
    run(function (supabase) {
      return supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.ValhallaSupabase.osReturnTo() }
      }).then(function (result) {
        if (result && result.error) say(window.ValhallaSupabase.providerMessage(result.error));
      });
    });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var address = email.value.trim();
    if (!address) return;
    say('Sending the sign-in link…');
    run(function (supabase) {
      return supabase.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: window.ValhallaSupabase.osReturnTo() }
      }).then(function (result) {
        if (result && result.error) say(window.ValhallaSupabase.providerMessage(result.error));
        else say('Check your email for the sign-in link.');
      });
    });
  });

  window.addEventListener('pageshow', function (event) {
    if (event && event.persisted) unlock();
  });

  if (!window.ValhallaSupabase.config()) {
    say('Sign-in is not configured yet.');
    return;
  }

  window.ValhallaSupabase.client().then(function (supabase) {
    return supabase.auth.getSession();
  }).then(function (result) {
    var user = result && result.data && result.data.session && result.data.session.user;
    if (user) window.location.replace('/os/');
  }).catch(function (error) {
    if (busy) return;
    say(window.ValhallaSupabase.providerMessage(error));
  });
})();
