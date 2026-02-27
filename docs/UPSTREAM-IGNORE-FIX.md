Summary
=======

This repository includes a runtime-side quick-fix for model-returned `IGNORE` actions
that was applied directly to the packaged server/runtime distributions under
`node_modules` and `packages/core/dist` to avoid noisy "Action not found" errors.

Goal
----

Persist this fix in the TypeScript source so it survives installs and builds.

What to change (high level)
---------------------------
- In the messaging session message handler (source: `src/api/messaging/sessions.ts`)
  add a best-effort readiness wait before processing inbound messages. The wait
  should:
  - attempt to look up the agent object by `session.agentId` (via the ElizaOS
    server/agent API available in the handler context),
  - prefer an explicit `isReady` boolean on the agent if provided, or call a
    `getRegisteredActions()` helper if available,
  - sleep for a short interval (100ms) and retry up to a reasonable timeout
    (e.g. 3 seconds) before continuing.

- In the core action resolution path (source: `packages/core/src`), add
  diagnostic logging of the normalized action value and the registered action
  names (for easier debugging), and add an explicit harmless fast-path for
  the `IGNORE` action that records an "ignored" memory or no-op instead of
  throwing an "Action not found" error.

Why this approach
------------------
- The wait reduces race conditions where a remote agent runtime hasn't finished
  registering its actions when the server delivers the first message.
- The IGNORE fast-path defends against model outputs that intentionally return
  `IGNORE` as a valid outcome (no action to take) and prevents noisy error
  logs that can obscure real problems.

Files touched (suggested)
-------------------------
- `packages/server/src/api/messaging/sessions.ts` (or wherever your project's
  messaging session handler lives) — add the readiness wait.
- `packages/core/src/index.ts` or equivalent action resolver — add logging and
  IGNORE fast-path.

Testing checklist
-----------------
1. Run the server locally.
2. Start an AgentRuntime with a matching `agentId` and confirm `getRegisteredActions()` returns values.
3. Create a session and send a message that causes the model to return `<actions>IGNORE</actions>`.
4. Confirm server logs show the diagnostic normalization info and no "Action not found" errors.

Notes / Next steps
------------------
- I applied the quick-fix in-place to the running server distribution so you
  can continue testing locally; to make it permanent, apply the above edits
  in your TypeScript sources and rebuild the server package.
