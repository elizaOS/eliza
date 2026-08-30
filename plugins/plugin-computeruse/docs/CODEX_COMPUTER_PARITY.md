# Codex Computer interface parity

This matrix compares the verified bundled `@Computer` contract with the
elizaOS Computer Use app-control lane. “Have” means the source contract and a
deterministic test exist. It does not mean the helper has been accepted in a
signed app on a permissioned physical Mac.

| Bundled behavior | elizaOS v2 status | Evidence and boundary |
| --- | --- | --- |
| `list_apps` | Have | `computer_list_apps` maps to the exact `list_apps` service command and packaged `NSWorkspace` helper; authenticated `GET /api/computer-use/apps` is read-only. |
| `get_app_state(app)` screenshot + AX tree | Have, physical acceptance pending | `computer_get_app_state` maps to the exact `get_app_state` command. Direct `AXUIElement` traversal is paired with a focused-window region screenshot. The region capture is app-scoped by AX bounds but can include occluding windows; signed-app ScreenCaptureKit window isolation is a future parity improvement. |
| Incremental state diffs | Have | Per-app state IDs return added, changed, removed indices and AX-text change. `disableDiff=true` forces a full state. |
| Ephemeral `element_index` | Have | Indices are one-based and state-bound. Any recapture invalidates every prior index; native locators remain private and are revalidated before dispatch. |
| App-scoped click | Have | `AXPress`/`AXConfirm` first; Set-of-Marks/OCR then guarded pointer fallback when policy approved. |
| App-scoped key/type | Have, physical acceptance pending | Unicode/key events are posted to the target PID. They do not move the system pointer. |
| App-scoped paste + clipboard restoration | Have, physical acceptance pending | All pasteboard item type/data pairs are snapshotted and restored when the injected clipboard has not been externally changed. Clipboard content is never returned or logged. |
| App-scoped scroll | Partial | Exposed AX page-scroll actions are semantic-first. If absent, visual grounding plus guarded physical scroll is available. Fine-grained AX scroll amounts vary by app. |
| Set value and select text | Have | `AXValue` and `AXSelectedTextRange`; failures do not silently become typed-key success. |
| Exposed secondary AX actions | Have | Only action names returned by `AXUIElementCopyActionNames` can execute. |
| Automatic fresh-state recapture | Have | Every app action returns a new app state. Every consequential session action also captures a fresh verification observation; capture failure produces `UNCERTAIN_EFFECT`. |
| Visible agent cursor/target | Have | Orange target overlay and virtual cursor are renderer-only. Planning and hover do not call the input driver. |
| No physical pointer movement during semantic planning | Have | AX, PID key events, and the overlay path do not inject mouse movement. |
| Arbitrary coordinate fallback | Guarded limitation | macOS exposes one real system pointer. Last-resort arbitrary clicks/scrolls can move it, require session authority plus approval, and are recorded as `physicalPointerMoved: true`. |
| Multi-display | Have | AX bounds remain OS-global; capture chooses the containing display and existing display-local/global conversion owns injection. |
| Permission readiness | Have, physical acceptance pending | Helper checks `AXIsProcessTrusted()` without prompting. UI reports Accessibility separately from capture/input/vision. No code changes OS permission state. |
| Pause/stop/lease/cancel | Have | Existing canonical session manager remains the sole host/target lease and cancellation authority. |
| Prompt-injection resistance | Have | AX/screenshot/OCR content stays untrusted model data; canonical dispatch, approval policy, secure-value redaction, stale observation checks, and repeated-action guard remain in force. |
| Action receipts | Have | Receipt includes before/after state IDs, mode, target, changed state, clipboard restoration, and whether the physical pointer moved. |

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
| `app_key` | `app`, `stateId`, `key`, optional `modifiers` |
| `app_type` | `app`, `stateId`, `text` |
| `app_paste` | `app`, `stateId`, `text`, optional `format` |
| `app_scroll` | `app`, `stateId`, `element_index`, optional `direction`, `amount` |
| `app_set_value` | `app`, `stateId`, `element_index`, `text` |
| `app_select_text` | `app`, `stateId`, `element_index`, `text` |
| `app_secondary_action` | `app`, `stateId`, `element_index`, `secondaryAction` |
| `app_hover_target` | `app`, `stateId`, `element_index` |

`allowPhysicalFallback: true` is only a request. It does not bypass canonical
session authority or the approval manager.
