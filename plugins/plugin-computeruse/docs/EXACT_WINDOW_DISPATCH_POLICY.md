# Exact-window pointer dispatch policy

## Decision

The shared signed Computer Use plugin does not ship a private macOS
exact-window pointer dispatcher. The route is reported as `policy_blocked`, and
click or scroll refuses when semantic Accessibility is unavailable unless the
operator separately enables and approves the existing global physical fallback.

This is a distribution-policy boundary, not an assertion that exact-window
background dispatch is technically impossible. elizaOS builds both a direct
Developer ID/notarized application and a Mac App Store variant from the same
packaged application dependency graph. The store variant recursively signs
nested Mach-O helpers. No verified packaging rule excludes a Computer Use
private-API helper from the store submission. Apple App Review Guideline 2.5.1
requires App Store apps to use public APIs, while the studied implementation
depends on undocumented SkyLight symbols. Resolving those symbols dynamically
changes link-time mechanics but does not make them public APIs.

No source, binary, package, dependency, permission grant, or native dispatcher
from the references below was imported. Consequently there is no new runtime
third-party component to list in the packaged notices.

## Production route matrix

| Route | Delivery scope | Pointer effect | Status | Verification boundary |
| --- | --- | --- | --- | --- |
| Semantic AX | Indexed AX element in a uniquely bound `(pid, CGWindowID)` window | None | Supported | Re-resolve locator and exact window, then fresh target readback |
| Browser CDP | Exact browser target | Software-only browser pointer | Supported | Target-bound browser state/readback; not represented as a CGWindowID claim |
| PID keyboard | Process | None | Conditional | One eligible same-PID window, exact binding unchanged, indexed target changed |
| Exact-window pointer | CGWindowID window | None | Policy blocked | No public production implementation in the shared signed bundle |
| Isolated target | Sandbox, VM, or remote guest | Guest-local/software | Conditional | Backend must provide target-bound observation and action receipt |
| Global physical pointer | Host global | Moves the one system pointer | Disabled by default | Environment opt-in, explicit request, pointer provenance, separate approval |

PID mouse or scroll events are not an exact-window route and are not present in
the native helper. PID keyboard events are likewise never described as
window-addressed. Sibling-window state, generic screenshot change, or an
unchanged `focusedWindowId` cannot independently prove an action affected the
requested target.

## Requirements before reconsidering a separate direct-distribution module

A future proposal must be a separately packaged component that is provably
absent from every Mac App Store artifact. It must remain disabled by default and
must pass legal/release review plus signed direct-package acceptance. Its ABI
must be capability-probed at runtime; exact `(pid, CGWindowID)` and window-local
coordinates must be revalidated immediately before dispatch; foreground app,
window order, and Space must remain unchanged; global HID fallback must be
impossible; and receipts must include pointer before/after plus action-specific
target readback. Same-PID sibling windows and indistinguishable title/bounds
windows must be negative canaries. Unsupported macOS versions or missing
symbols must return an explicit refusal.

Until all of those conditions are met, adding a dormant private helper to the
shared package is not acceptable and the route must not be automatic.

## Design references and attribution

- iFurySt/open-codex-computer-use commit
  `ead48da2032c69b892c89fd39d38fa587b4d6fbf`, specifically
  `SkyLightSPI.swift` and `SkyClickSimulation.swift`, MIT License, copyright
  2026 Leo. The source dynamically probes private event/focus symbols, carries
  PID, CGWindowID, and window-local coordinates, and uses a software cursor.
- The same repository's `THIRD_PARTY_NOTICES.md` attributes its Cua-derived
  driver recipe to trycua/cua commit
  `b8a0f32a06c75225ba24ebb5ab14f6507fa90d15` (MIT, copyright 2025 Cua AI,
  Inc.) and focus-without-raise work to yabai commit
  `dd845723416f5fe92af49fad5ebab00369e07edd` (MIT, copyright 2019 Åsmund
  Vikane).
- trycua/cua's macOS window-internals note describes SkyLight as undocumented
  private API and distinguishes PID-level posting from exact application
  behavior.
- Apple App Review Guidelines 2.5.1 are the controlling store-distribution
  policy source. Apple Developer ID and notarization documentation describe the
  separate direct-distribution trust path but do not convert private API into a
  supported public contract.

Reference URLs:

- <https://github.com/iFurySt/open-codex-computer-use/blob/ead48da2032c69b892c89fd39d38fa587b4d6fbf/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SkyLightSPI.swift>
- <https://github.com/iFurySt/open-codex-computer-use/blob/ead48da2032c69b892c89fd39d38fa587b4d6fbf/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/SkyClickSimulation.swift>
- <https://github.com/iFurySt/open-codex-computer-use/blob/ead48da2032c69b892c89fd39d38fa587b4d6fbf/THIRD_PARTY_NOTICES.md>
- <https://github.com/iFurySt/open-codex-computer-use/blob/ead48da2032c69b892c89fd39d38fa587b4d6fbf/LICENSE>
- <https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md>
- <https://developer.apple.com/app-store/review/guidelines/>
- <https://developer.apple.com/support/developer-id/>
- <https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution>
