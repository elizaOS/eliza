# elizaOS Live mode parity

elizaOS Live v1.0 has two independent boot choices:

- Storage: amnesia or persistent USB
- Network privacy: normal direct internet or Privacy Mode through Tor

The product requirement is that the same capabilities are available in all
four combinations. Mode changes can affect speed, persistence, and trace
footprint, but they must not silently remove features.

Status as of 2026-05-16: the Phase 3-7 overlays are present in source and
a full rebuild/test pass is in progress. Treat the table below as the
target acceptance matrix until Phase 8 produces evidence from the rebuilt
ISO.

## Matrix

| Feature | Normal + amnesia | Normal + persistent USB | Privacy + amnesia | Privacy + persistent USB |
|---|---|---|---|---|
| elizaOS normal GNOME window launches and is supervised | Yes | Yes | Yes | Yes |
| Local LLM chat | Yes | Yes | Yes | Yes |
| BUILD_APP with local stub | Yes | Yes | Yes | Yes |
| BUILD_APP with Claude CLI | Yes | Yes | Yes, slower | Yes, slower |
| Voice stack | Yes | Yes | Yes | Yes |
| SET_WM / wallpaper / shell actions | Yes | Yes | Yes | Yes |
| GPU acceleration | Yes | Yes | Yes | Yes |
| Cloud APIs | Fast | Fast | Slow | Slow |
| OAuth flows | Expected | Expected | May be blocked by provider | May be blocked by provider |
| Chromium browser windows | Yes | Yes | Known v1.0 gap | Known v1.0 gap |
| Chat history survives reboot | No | Yes | No | Yes |
| Built apps survive reboot | No | Yes | No | Yes |
| Downloaded models survive reboot | No | Yes | No | Yes |
| Wi-Fi passwords survive reboot | No | Yes | No | Yes |
| API keys survive reboot | No | Yes, encrypted in LUKS-backed state | No | Yes, encrypted in LUKS-backed state |

## Acceptance Rule

If a future phase discovers a capability that cannot work in one of the four
modes, the gap must be recorded here before merge. The preferred fix is to
restore feature parity. A documented caveat is acceptable only when the phase
plan explicitly defers the fix.
