(function (root) {
  var SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';

  function config() {
    var site = root.VALHALLA_SITE || {};
    var url = String(site.SUPABASE_URL || '');
    var key = String(site.SUPABASE_PUBLISHABLE_KEY || '');
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(url)) return null;
    if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return null;
    return { url: url, key: key };
  }

  function osReturnTo() {
    var host = root.location && root.location.hostname;
    if (host === 'www.valhalla-app.xyz') return 'https://www.valhalla-app.xyz/os/';
    return 'https://valhalla-app.xyz/os/';
  }

  var shared = null;

  function client(loader) {
    if (shared) return shared;
    var settings = config();
    if (!settings) return Promise.reject(new Error('Sign-in is not configured yet.'));
    var load = typeof loader === 'function' ? loader : function () { return import(SDK); };
    shared = load().then(function (mod) {
      if (!mod || typeof mod.createClient !== 'function') throw new Error('Sign-in is not configured yet.');
      return mod.createClient(settings.url, settings.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' }
      });
    }).catch(function (error) {
      shared = null;
      return Promise.reject(error);
    });
    return shared;
  }

  function providerMessage(error) {
    var text = error && error.message ? String(error.message) : 'Sign-in did not start.';
    if (/not enabled|disabled|unsupported provider/i.test(text)) return text;
    return text;
  }

  function levelLabel(value) {
    var text = String(value || '').toLowerCase();
    if (text === 'pro') return 'Pro';
    if (text === 'unlimited') return 'Unlimited';
    return 'Free';
  }

  root.ValhallaSupabase = {
    config: config,
    osReturnTo: osReturnTo,
    client: client,
    providerMessage: providerMessage,
    levelLabel: levelLabel
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
