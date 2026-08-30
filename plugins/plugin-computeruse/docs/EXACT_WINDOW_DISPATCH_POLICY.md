# Exact-window pointer dispatch policy

## Decision

The shared Computer Use plugin and every Mac App Store artifact exclude the
private macOS exact-window implementation. Direct builds may separately package
an optional `computeruse-exact-window-helper` executable. It is disabled by
default, capability-probed at runtime, and exposed only as
`experimental_direct_exact_window`. It is not production-accepted and cannot
become an automatic route until legal/release review and signed direct-package
acceptance are complete.

This is a distribution-policy boundary, not an assertion that exact-window
background dispatch is technically impossible. elizaOS builds both a direct
Developer ID/notarized application and a Mac App Store variant from the same
packaged application dependency graph. The store variant recursively signs
nested Mach-O helpers. No verified packaging rule excludes a Computer Use
private-API helper from the store submission. Apple App Review Guideline 2.5.1
requires App Store apps to use public APIs, while the studied implementation
depends on undocumented SkyLight symbols. Resolving those symbols dynamically
changes link-time mechanics but does not make them public APIs.

The direct-only component adapts the pinned MIT event recipe in a separate
source directory and carries its own third-party notice. The Mac App Store
build rejects the component flag, omits its copy mapping and runtime authority,
and scans the finished artifact for its names, route, private framework path,
and private symbol names.

## Production route matrix

| Route | Delivery scope | Pointer effect | Status | Verification boundary |
| --- | --- | --- | --- | --- |
| Semantic AX | Indexed AX element in a uniquely bound `(pid, CGWindowID)` window | None | Supported | Re-resolve locator and exact window, then fresh target readback |
| Browser CDP | Exact browser target | Software-only browser pointer | Supported | Target-bound browser state/readback; not represented as a CGWindowID claim |
| PID keyboard | Process | None | Conditional | One eligible same-PID window, exact binding unchanged, indexed target changed |
| Experimental direct exact-window pointer | Exact `(pid, CGWindowID)` candidate | Intended none; signed proof pending | Direct-only, disabled by default | Runtime symbol probe, exact stale/bounds checks, pointer before/after, and action-specific target readback |
| Isolated target | Sandbox, VM, or remote guest | Guest-local/software | Conditional | Backend must provide target-bound observation and action receipt |
| Global physical pointer | Host global | Moves the one system pointer | Disabled by default | Environment opt-in, explicit request, pointer provenance, separate approval |

PID mouse or scroll events are not an exact-window route and are not present in
the native helper. PID keyboard events are likewise never described as
window-addressed. Sibling-window state, generic screenshot change, or an
unchanged `focusedWindowId` cannot independently prove an action affected the
requested target.

## Direct-only selection contract

The runtime considers this route only for app-scoped click or scroll after the
normal semantic AX attempt refuses. Browser targets remain on their exact CDP
path, while process-scoped keyboard compatibility applies only to keyboard and
text actions. Selection additionally requires all of the following:

- a direct macOS build containing the separately copied executable and notice;
- build-time and runtime opt-ins;
- a successful helper probe for the full private ABI and minimum macOS version;
- a current observation bound to exact PID, CGWindowID, screenshot bounds, and
  indexed element bounds;
- a distinct action-time approval bound to that observation and target; and
- physical pointer provenance before dispatch.

After approval, the coordinator recaptures AX state and requires unchanged PID,
CGWindowID, window bounds, element locator, and element bounds before invoking
the helper. The helper then revalidates the window on-screen owner, ID, bounds,
screen point, and window-local point immediately before dispatch. The
coordinator validates the helper receipt and requires fresh same-window,
action-specific target readback. After dispatch it independently reads the
physical pointer again; experimental success requires that coordinator-owned
observation to be exactly `unchanged`. A `changed` or `unavailable` observation
refuses even if the child reports stable coordinates. A sibling same-PID
mutation or generic screenshot delta is not semantic effect proof. Once a
validated helper receipt proves that delivery was posted, absent target-local
readback is returned as `posted_unconfirmed`; it is never rewritten into a
retryable false failure after the side effect. Only target-local readback marks
the effect `confirmed`. Missing symbols,
stale/ambiguous targets, unavailable provenance, or pointer movement return
refusal and never fall through implicitly.

Global HID posting is absent from the component. Global physical fallback
remains a later, separately opted-in and separately approved route.

## Distribution and acceptance boundary

Build inclusion requires
`--build-experimental-exact-window-helper` on a `direct` macOS build. Runtime
selection additionally requires
`ELIZA_COMPUTERUSE_EXPERIMENTAL_EXACT_WINDOW=1`, request field
`allowExperimentalExactWindow: true`, and the separate action-time approval.
The direct embedded runtime adapter resolves only the fixed helper sibling in
the app resources tree; packaged children cannot substitute an arbitrary path.
The shared desktop shell has no helper-specific launcher import or path.

The helper is not a security boundary from other same-UID processes. Direct
release acceptance must bind the bundle-local helper manifest hash to its
nested Developer ID signature and the enclosing notarized app before trusting
receipts. An operator-supplied development path is explicitly outside that
packaged code-signing claim. Symbol discovery proves only presence, not private
SkyLight ABI stability or Apple support.

The Store build rejects the component build flag. Its copy map is empty, the
Store package has no embedded agent runtime, the published Electrobun source
manifest excludes `direct-only/` and `build/`, and the Store artifact verifier
rejects helper, route, private-framework, and private-symbol markers.

No live dispatch, TCC grant, signing, notarization, or physical-pointer test was
performed for this source checkpoint. Legal/release approval, signed direct
packaging proof, a real capability probe, and disposable same-PID multi-window
acceptance remain mandatory. Until those gates pass, the readiness matrix must
not claim accepted exact-window delivery and the route must not be automatic.

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
