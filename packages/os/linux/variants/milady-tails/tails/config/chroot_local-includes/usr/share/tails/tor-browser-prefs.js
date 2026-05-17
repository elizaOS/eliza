// Tails-specific configuration below

// Since the slider notification will be shown every time at each Tails
// boot, which is bad (nagging) UX, we disable it.
pref("extensions.torbutton.show_slider_notification", false);

// Suppress prompt and always spoof useragent as English
pref("privacy.spoof_english", 2);

// Tails-specific Torbutton preferences
pref("extensions.torbutton.lastUpdateCheck", "9999999999.999");

// Skip migration of prefs from Tor Browser 5 or older
pref("extensions.torbutton.pref_fixup_version", 1);

// These must be set to the same value to prevent Torbutton from
// flashing its upgrade notification.
pref("extensions.torbutton.lastBrowserVersion", "Tails");
pref("torbrowser.version", "Tails");

// Other non-Torbutton, Tails-specific prefs
pref("browser.download.folderList", 2);
pref("browser.download.manager.closeWhenDone", true);
pref("extensions.update.enabled", false);
pref("layout.spellcheckDefault", 0);
pref("network.dns.disableIPv6", true);
pref("security.warn_submit_insecure", true);

// Without setting this, the Download Management page will not update
// the progress being made.
pref("browser.download.panel.shown", true);

// Given our AppArmor sandboxing, Tor Browser will not be allowed to
// open external applications, so let's not offer the option to the user,
// and instead only propose them to save downloaded files.
pref("browser.download.forbid_open_with", true);

// Disable the Pocket service integration
pref("extensions.pocket.enabled", false);

// Set the hunspell directory. This shouldn't be required anymore in
// Tor Browser based on Firefox 68
pref("spellchecker.dictionary_path", "/usr/share/hunspell");

// Suppress the "Tor Browser has set your display language to
// $language based on your system’s language" prompt.
pref("intl.language_notification.shown", true);

// Enable userChrome.css for UI customizations
pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);

// Hide warning when downloading files: "Be careful opening downloads"
pref("browser.download.showTorWarning", false);

// Hide bookmarks toolbar
pref("browser.toolbars.bookmarks.visibility", "never");

// On Wayland, when starting the browser its window is resized so the
// bottom part is outside of the screen
// (https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/43693)
// which we work around through this pref.
pref("privacy.resistFingerprinting.letterboxing.rememberSize", true);

// Let Tor Browser know that it is running inside Tails, which
// e.g. enables a more appropriate about:tor page.
pref("torbrowser.running_in_tails", true);
