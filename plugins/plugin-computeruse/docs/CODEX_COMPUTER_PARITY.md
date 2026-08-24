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
| App-scoped click | Partial, experimental direct route added | `AXPress`/`AXConfirm` remain first. Shared and Store artifacts contain no PID-mouse or private exact-window dispatcher. An optional direct-only helper can be selected after AX refusal only with build/runtime/request opt-ins, capability probe, exact current binding, and a separate action-time approval. Signed physical acceptance remains open. |
| App-scoped key/type | Partial, physical acceptance pending | Keyboard events are process-scoped. They require an indexed element, exactly one eligible same-PID window, unchanged exact-window binding, and target-element readback. Otherwise the action refuses; it never claims window-addressed delivery. |
| App-scoped paste + clipboard restoration | Have, physical acceptance pending | All pasteboard item type/data pairs are snapshotted and restored when the injected clipboard has not been externally changed. Clipboard content is never returned or logged. |
| App-scoped scroll | Partial, experimental direct route added | Exposed AX page-scroll actions remain first. Shared and Store artifacts never post process-scoped wheel events. The optional direct-only exact-window route has the same probe/binding/approval gates as click; signed physical acceptance remains open. |
| Set value and select text | Have | `AXValue` and `AXSelectedTextRange`; failures do not silently become typed-key success. |
| Exposed secondary AX actions | Have | Only action names returned by `AXUIElementCopyActionNames` can execute. |
| Automatic fresh-state recapture | Have | Every app action returns a new app state. Every consequential session action also captures a fresh verification observation; capture failure produces `UNCERTAIN_EFFECT`. |
| Visible agent cursor/target | Have | Orange target overlay and virtual cursor are renderer-only. Planning and hover do not call the input driver. |
| No physical pointer movement during semantic planning | Have in deterministic source harness | AX, process-scoped keyboard events, and the overlay do not invoke Eliza's global pointer driver. Receipts independently record before/after coordinates; movement without input is external/unknown, never virtual. Signed-app proof remains open. |
| Arbitrary coordinate fallback | Refused | No global HID request or driver route is registered. Receipts still distinguish physical-input provenance from independently observed pointer movement. |
| Multi-display | Have | AX bounds remain OS-global; capture chooses the containing display and existing display-local/global conversion owns injection. |
| Permission readiness | Have, physical acceptance pending | Helper checks `AXIsProcessTrusted()` without prompting. UI reports Accessibility separately from capture/input/vision. No code changes OS permission state. |
| Pause/stop/lease/cancel | Have | Existing canonical session manager remains the sole host/target lease and cancellation authority. |
| Prompt-injection resistance | Have | AX/screenshot/OCR content stays untrusted model data; canonical dispatch, approval policy, secure-value redaction, stale observation checks, and repeated-action guard remain in force. |
| Action receipts | Have | Receipt includes target PID/window binding, truthful execution mode, before/after state IDs, clipboard restoration, pointer coordinates/observation, physical-input provenance, and any direct-only experimental approval ID. |

## Dispatch boundary

The v5 order remains semantic AX for native app actions and exact browser/CDP
for browser targets. Process-scoped keyboard delivery is a narrower keyboard
and text compatibility route with the single-window and target-readback
constraints above. Only app click/scroll may next request the optional
`experimental_direct_exact_window` component, and only after its independent
probe, binding, opt-in, approval, provenance, and verification gates pass.
Background operation never raises a real window, changes Spaces, or falls
through to global HID. No global physical-input fallback mode is registered.

The v5 packaging lane keeps the studied private SkyLight route outside the
shared plugin and every Store source/artifact manifest. A direct-only build flag
produces and copies the separate executable; the Store flag is rejected and the
finished Store artifact is scanned for component/private-symbol markers. The
readiness DTO keeps exact-window delivery unaccepted and disabled by default
until signed direct acceptance. See
[`EXACT_WINDOW_DISPATCH_POLICY.md`](./EXACT_WINDOW_DISPATCH_POLICY.md).

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
`ead48da2032c69b892c89fd39d38fa587b4d6fbf`. Compatible concepts were adapted: AX-first dispatch,
software-cursor separation, global-pointer refusal, process/window
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
| `app_click` | `app`, `stateId`, `element_index`, optional `allowExperimentalExactWindow` |
| `app_key` | `app`, `stateId`, `element_index`, `key`, optional `modifiers` |
| `app_type` | `app`, `stateId`, `element_index`, `text` |
| `app_paste` | `app`, `stateId`, `element_index`, `text`, optional `format` |
| `app_scroll` | `app`, `stateId`, `element_index`, optional `direction`, `amount`, `allowExperimentalExactWindow` |
| `app_set_value` | `app`, `stateId`, `element_index`, `text` |
| `app_select_text` | `app`, `stateId`, `element_index`, `text` |
| `app_secondary_action` | `app`, `stateId`, `element_index`, `secondaryAction` |
| `app_hover_target` | `app`, `stateId`, `element_index` |

Requests that cannot use semantic AX or the separately selected direct-only
experimental route fail closed without global input.

`allowExperimentalExactWindow: true` is likewise only a request. It does not
bypass direct-distribution packaging, runtime capability probing, exact current
binding, pointer provenance, or its separate action-time approval.
