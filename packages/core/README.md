# @elizaos/core

The Node runtime kernel: plugin registration, authorization, state composition,
model dispatch, memory, cancellation and effect settlement.

Use `@elizaos/core` for the Node runtime and `@elizaos/core/protocol` for
browser-safe contracts and pure helpers. Internal modules import their defining
files directly. Implementation leaves are private; JSON catalog assets retain
explicit data exports. Hosts compose database adapters, model providers and
`@elizaos/plugin-assistant` explicitly.

HTTP lifecycle, process guards, restart, application configuration and boot environment resolution live
in `@elizaos/host`, with browser-safe configuration in `@elizaos/host/protocol`.
Portable acoustic processing lives in `@elizaos/voice`.
Cross-domain DTOs and validation live in `@elizaos/contracts`. Core imports none
of these owners.

Runtime settings are per-agent. Explicit host environment fallbacks remain for
the secret/PII master switches and process execution policies; per-agent switch
values take precedence. Model context, authorization evidence and effect receipts
remain complete. Source restoration requires its original authorized binding.

`asRecord` accepts plain records; `asObjectRecord` also accepts class and built-in
object instances. Both reject arrays and null. `hasPlainObjectTag` checks the
object tag. Persisted canonical JSON bytes retain their existing meaning;
`stableJsonString` returns `undefined` for JSON-invisible root values.

From the repository root:

```bash
bun run --cwd packages/core build
bun run --cwd packages/core test
bun run --cwd packages/core typecheck
bun run --cwd packages/core lint:check
bun run verify
```

The browser-safe protocol exports `TaskEventReader` and `mergeTaskEventPage` for
read-only task activity feeds. Inject a task ID/cursor read transport and a state
observer; call `start(taskId)`, `refresh()` for explicit retry, and `stop()` on
teardown. The reader validates every page against the shared event protocol,
retains admitted history on failure, fences stale replies across task switches,
and polls until a terminal task has no unknown outcome. It never runs task actions.
Hosts own activity labels, layout, reading position, error copy, and task-control
refresh policy. Observer snapshots are detached from the admitted history.
