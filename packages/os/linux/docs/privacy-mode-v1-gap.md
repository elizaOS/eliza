# Privacy Mode v1 Embedded Web Gap

Privacy Mode is intended to route elizaOS agent traffic through Tor by
booting the live networking stack in Tor-only mode. That covers
agent-side requests made from Bun, system tools, and the preserved
Tor-managed browser path once the rebuilt ISO passes network validation.

The known v1.0 gap is embedded browser/OAuth traffic launched by the app
runtime. The active shell must explicitly prove proxy behavior in Privacy
Mode; otherwise external web windows may bypass Tor even when the live OS
network stack is in Tor-only mode.

## v1.0 Behavior

- elizaOS agent requests: intended to route through Tor in Privacy Mode;
  must be verified in the rebuilt ISO.
- Tor-managed browser behavior: preserved from the upstream live-OS stack.
- Embedded browser/OAuth windows: not guaranteed to use Tor in v1.0.
- Mode switching: requires reboot because Privacy Mode is selected from the
  boot menu.

## v1.1 Fix Direction

Patch the active app shell/runtime to inject a Tor proxy when Privacy Mode is
active. If CEF/Electrobun is active, that likely means a Chromium proxy flag
such as `--proxy-server=socks5://127.0.0.1:9050`; if WebKit is active, it
needs equivalent WebKit/network-context proof. Add an integration check that
proves embedded web traffic exits through Tor.

Until that lands, Privacy Mode UX must disclose the embedded web/OAuth caveat
anywhere users can open external web content from the elizaOS app.
