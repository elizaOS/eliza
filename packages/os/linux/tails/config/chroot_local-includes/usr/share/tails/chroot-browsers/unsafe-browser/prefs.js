// Disable proxying in the chroot
user_pref("extensions.torbutton.use_nontor_proxy", true);
user_pref("network.proxy.type", 0);
user_pref("network.proxy.socks_remote_dns", false);

// Tor Browser disables DNS resolution via this pref to plug a class
// of DNS leaks, so we have to re-enable it. For details, see:
// * https://gitlab.torproject.org/legacy/trac/-/issues/5741
// * https://bugzilla.mozilla.org/show_bug.cgi?id=1618271
user_pref("network.dns.disabled", false);

// Without setting this, the Download Management page will not update
// the progress being made.
user_pref("browser.download.panel.shown", true);

// Disable searching from the URL bar. Mistyping e.g. the IP address
// to your router or some LAN resource could leak to the default
// search engine (this could include credentials, e.g. if something
// like the following is mistyped: ftp://user:password@host).
user_pref("keyword.enabled", false);

// Use the red theme
user_pref("extensions.activeThemeID", "{91a24c60-0f27-427c-b9a6-96b71f3984a9}");

// Required to hide the security level button
user_pref("extensions.torbutton.inserted_button", true);
user_pref("extensions.torbutton.inserted_security_level", true);

// Don't enable private browsing mode by default
user_pref("browser.privatebrowsing.autostart", false);

// onionrewrites are useless and even dangerous for Unsafe Browser:
// in fact, when they are enabled, the browser will fetch data from relevant websites
// (ie: securedrop.org), which will hint any attacker that this is a Tails.
user_pref("browser.urlbar.onionRewrites.enabled", false);

// The HTTPS-only mode is relevant for securely visiting websites,
// but makes captive portals look unnecessarily fishy just because
// they are in HTTP
user_pref("dom.security.https_only_mode", false);

// Don't ask confirmation when quitting with CTRL+q: the user is not
// supposed to be doing meaningful work in the Unsafe Browser, that we
// should avoid losing. This makes our test suite simpler.
user_pref("browser.warnOnQuitShortcut", false);
