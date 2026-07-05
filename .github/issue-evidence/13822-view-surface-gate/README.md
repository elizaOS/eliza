# View surface-grant gate (#13822 hardening)

Gates **mutating** view interactions (`click-element`, `fill-input`, `agent-click`,
`agent-fill`, `agent-focus`, `agent-scroll-to`, `set-highlight`, `refresh`,
`focus-element`) behind the explicit `surface.capabilities: ["agent-surface"]`
grant on the view declaration. **Read-only** capabilities (`get-state`,
`get-text`, `list-elements`, `describe-element`, `get-focus`, `get-agent-state`)
stay open without any grant. The gate runs at both the HTTP interact route
(`POST /api/views/:id/interact`) and the shared `dispatchViewInteract()` path
used by activate + view-scoped actions.

This matches the canonical `SurfaceManifest` `agent-surface` capability contract
(`packages/core/src/types/surface-manifest.ts`): "Standard read-only
introspection is always available; this grant is for a view opting INTO richer
agent control."

## Real-path test evidence

`surface-grant-tests.txt` — full run output. Decisive assertions:

- **Denied without grant** (`views-routes.interact-coverage.test.ts`): a
  `click-element` interact against `surface-denied-server` (no `agent-surface`
  grant) is rejected with HTTP **403** *before* `serverInteract` is called, with
  message `View "…" is not granted capability "click-element" (its surface
  manifest does not grant \`agent-surface\`)`. `json` is never called.
- **Allowed with grant**: the same `click-element` against
  `surface-granted-server` (grants `agent-surface`) reaches `serverInteract` and
  returns `success: true`.
- **Read-only bypass**: `get-state` dispatches on a view with no grant.
- **Built-in character view** (`view-scoped-actions.test.ts`): its scoped
  actions drive real `agent-fill`/`agent-click` steps through the gate — the
  view now declares the `agent-surface` grant (its scoped actions are its whole
  purpose), so `VIEW_CHARACTER_FILL_BIO` / `ADD_STYLE_RULE` / `ADD_MESSAGE_EXAMPLE`
  execute, and an unmounted target still fails loudly with
  `VIEW_SCOPED_ACTION_ELEMENT_MISSING` (never a silent no-op).

29/29 targeted tests pass (`interact-coverage` 10, `view-scoped-actions` 15,
`activate` 4). Typecheck of the touched files is clean; the worktree-only
`TS2688` (missing `@types` resolution) is a pre-existing environment blocker
affecting every file equally.
