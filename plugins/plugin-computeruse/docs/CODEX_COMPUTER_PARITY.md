# Codex Computer interface parity

This matrix compares the verified bundled `@Computer` contract with the
elizaOS Computer Use app-control lane. “Have” means the source contract and a
deterministic test exist. It does not mean the helper has been accepted in a
signed app on a permissioned physical Mac.

| Bundled behavior | elizaOS v2 status | Evidence and boundary |
| --- | --- | --- |
| `list_apps` | Have | `computer_list_apps` maps to the exact `list_apps` service command and packaged `NSWorkspace` helper; authenticated `GET /api/computer-use/apps` is read-only. |
| `get_app_state(app)` screenshot + AX tree | Have, physical acceptance pending | State is bound to a unique `(pid, CGWindowID)` resolved from the focused AX window. Ambiguous same-bounds/title matches return no window ID, so mutation refuses. Region capture can still include occluding windows. |
| Incremental state diffs | Have | Per-app state IDs return added, changed, removed indices and AX-text change. `disableDiff=true` forces a full state. |
| Ephemeral `element_index` | Have | Indices are one-based and state-bound. Any recapture invalidates every prior index; native locators remain private and are revalidated before dispatch. |
| App-scoped click | Partial, fail closed | `AXPress`/`AXConfirm` are semantic and pointer-free. The helper has no genuine `CGWindowID`-addressed mouse dispatcher, so it does not post PID mouse events. Visual grounding can reach global physical fallback only after environment opt-in and a distinct action-time approval. |
| App-scoped key/type | Partial, physical acceptance pending | Keyboard events are process-scoped. They require an indexed element, exactly one eligible same-PID window, unchanged exact-window binding, and target-element readback. Otherwise the action refuses; it never claims window-addressed delivery. |
| App-scoped paste + clipboard restoration | Have, physical acceptance pending | All pasteboard item type/data pairs are snapshotted and restored when the injected clipboard has not been externally changed. Clipboard content is never returned or logged. |
| App-scoped scroll | Partial | Exposed AX page-scroll actions are semantic-first. The helper does not post process-scoped mouse-wheel events. If AX is absent, only separately opted-in and approved global physical scroll is available. |
| Set value and select text | Have | `AXValue` and `AXSelectedTextRange`; failures do not silently become typed-key success. |
| Exposed secondary AX actions | Have | Only action names returned by `AXUIElementCopyActionNames` can execute. |
| Automatic fresh-state recapture | Have | Every app action returns a new app state. Every consequential session action also captures a fresh verification observation; capture failure produces `UNCERTAIN_EFFECT`. |
| Visible agent cursor/target | Have | Orange target overlay and virtual cursor are renderer-only. Planning and hover do not call the input driver. |
| No physical pointer movement during semantic planning | Have in deterministic source harness | AX, process-scoped keyboard events, and the overlay do not invoke Eliza's global pointer driver. Receipts independently record before/after coordinates; movement without input is external/unknown, never virtual. Signed-app proof remains open. |
| Arbitrary coordinate fallback | Disabled by default | Global clicks/scrolls require `OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1`, an explicit fallback request, and a second action-time approval. Receipts distinguish `physicalPointerInput` from observed `physicalPointerMoved`. |
| Multi-display | Have | AX bounds remain OS-global; capture chooses the containing display and existing display-local/global conversion owns injection. |
| Permission readiness | Have, physical acceptance pending | Helper checks `AXIsProcessTrusted()` without prompting. UI reports Accessibility separately from capture/input/vision. No code changes OS permission state. |
| Pause/stop/lease/cancel | Have | Existing canonical session manager remains the sole host/target lease and cancellation authority. |
| Prompt-injection resistance | Have | AX/screenshot/OCR content stays untrusted model data; canonical dispatch, approval policy, secure-value redaction, stale observation checks, and repeated-action guard remain in force. |
| Action receipts | Have | Receipt includes target PID/window binding, truthful execution mode, before/after state IDs, clipboard restoration, pointer coordinates/observation, physical-input provenance, and the separate fallback approval ID. |

## Dispatch boundary

The v3 order is semantic AX, exact browser/CDP for browser targets, then an
exact window-local dispatcher only if one is implemented and independently
proven. The current helper has no such mouse dispatcher and refuses that step.
Process-scoped keyboard delivery is a narrower compatibility route with the
single-window and target-readback constraints above. Background operation never
activates an app, raises a window, changes Spaces, or implicitly falls through
to global HID. Global physical input is a separate supervised mode, disabled by
default.

Opening Eliza's own chat surface is not a Computer Use focus/click task. The
canonical shell already owns `eliza:chat:open` and the `open-chat` OS intent;
phone-to-Mac integration should bridge an authenticated semantic request to
that shell contract. The Computer Use session API can carry authenticated,
observation-bound semantic app actions and receipts, but this lane does not
manufacture a second shell protocol.

## Design references and attribution

The safety design was compared against MIT-licensed
`QwenLM/open-computer-use` at
`f238d1bc85b53bd785d2618d4fbb5d2402207c7a`, `trycua/cua` at the supplied
`737dc2a…` reference, and `iFurySt/open-codex-computer-use` at the supplied
`ead48da…` reference. Compatible concepts were adapted: AX-first dispatch,
software-cursor separation, explicit global-pointer opt-in, process/window
identity in receipts, and refusal on uncertainty. No dependency, binary, TCC
grant, or copied implementation was imported.

## Native packaging

`bun run --cwd plugins/plugin-computeruse build` compiles
`native/macos-ax-helper.swift` with the pinned host Xcode toolchain into
`dist/native/macos-ax-helper`. The package already publishes `dist`. Runtime
code never evaluates Swift source and fails closed when the helper is absent.

The helper does not request Accessibility trust. Signing, hardened-runtime
validation, TCC grants, and physical packaged-app interaction remain the macOS
integration owner’s acceptance boundary.

## App-control commands

Read-only operations are also authenticated HTTP endpoints. Mutations remain
session-bound so they pass through `authorizeInteractionDispatch`, observation
binding, repeated-action protection, approval mode, lease, stop/cancel, and
fresh verification.

| Command | Required parameters |
| --- | --- |
| `list_apps` (`app_list_apps` compatibility alias) | none |
| `get_app_state` (`app_get_state` compatibility alias) | `app`, optional `disableDiff` |
| `app_click` | `app`, `stateId`, `element_index` |
| `app_key` | `app`, `stateId`, `element_index`, `key`, optional `modifiers` |
| `app_type` | `app`, `stateId`, `element_index`, `text` |
| `app_paste` | `app`, `stateId`, `element_index`, `text`, optional `format` |
| `app_scroll` | `app`, `stateId`, `element_index`, optional `direction`, `amount` |
| `app_set_value` | `app`, `stateId`, `element_index`, `text` |
| `app_select_text` | `app`, `stateId`, `element_index`, `text` |
| `app_secondary_action` | `app`, `stateId`, `element_index`, `secondaryAction` |
| `app_hover_target` | `app`, `stateId`, `element_index` |

`allowPhysicalFallback: true` is only a request. It does not bypass canonical
session authority, the environment opt-in, pointer-provenance availability, or
the distinct last-moment approval.
