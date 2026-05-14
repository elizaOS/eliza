# Privacy Mode v1 Chromium WebView gap

Privacy Mode routes Milady agent traffic through Tor by booting the Tails
networking stack in Tor-only mode. That covers agent-side requests made from
Bun, system tools, and the Tails-managed browser path.

The known v1.0 gap is Chromium WebView traffic launched by the Electrobun
runtime. The WebView does not automatically inherit the SOCKS proxy used by
the agent process, so Chromium windows may bypass Tor unless Electrobun is
patched to inject an explicit proxy configuration.

## v1.0 Behavior

- Milady agent requests: routed through Tor in Privacy Mode.
- System Tor Browser behavior: preserved from Tails.
- Chromium WebView windows: not guaranteed to use Tor in v1.0.
- Mode switching: requires reboot because Privacy Mode is selected from the
  boot menu.

## v1.1 Fix Direction

Patch the Electrobun launch path to pass a Chromium proxy flag such as
`--proxy-server=socks5://127.0.0.1:9050` when Privacy Mode is active, and add
an integration check that proves WebView network traffic exits through Tor.

Until that lands, Privacy Mode UX must disclose the WebView caveat anywhere
users can open external web content from the Milady app.
