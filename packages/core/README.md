# @elizaos/core

Node runtime kernel for Eliza agents: plugin registration, authorization, state, model
dispatch, memory, and cancellation.

Import from `@elizaos/core`, including first-party catalog access and curated-app
registration. Hosts explicitly supply database adapters, model providers,
and `@elizaos/plugin-assistant` for conversational behavior. The root entrypoint is the Node runtime. Explicit leaf exports provide wire
contracts and pure utilities without loading that runtime. Core does not own host
route tables or install assistant behavior implicitly. Runtime settings are per-agent and do not implicitly read process.env.

The root also exports route DTOs, Markdown, and LifeOps helpers. Use
`KnowledgeGraphEntity` / `KnowledgeGraphRelationship` for graph records and
`FirstRunMessageExample` for setup examples; the existing `Entity`, `Relationship`,
and `MessageExample` names retain their runtime meanings.

Host configuration is exported from the root as well. `AppMemoryConfig` and
`AppX402Config` distinguish host settings from runtime settings; `ConfigUiPatchOp`
names configuration UI patches. `getAppBootConfigEnvAliases` and
`resolveAppAliasedEnvValue` retain the host store's initialization behavior.

Settings debug sanitizers, macOS permission links, and generated channel, provider,
and short-ID plugin maps are available through the root. Process crash guards also
use the root API and require the Node/Bun process host; importing core does not
install them. Settings debugging uses the host `ELIZA_SETTINGS_DEBUG` flag and
boot aliases; Vite debug flags are interpreted by the UI host.

Event names, payload contracts, and navigation-frame normalization are exported
from the root. DOM event creation and dispatch belong to the UI host.

HTTP contracts and explicit host helpers are available from the root. Hosts still
install their route lifecycle explicitly. `AgentStreamEventType` and `AgentLogEntry`
name HTTP DTOs; `StreamEventType` and `LogEntry` keep their runtime meanings.

Environment resolution, host execution settings, canonical JSON, transcript and
audio-redaction utilities are also available from the root.

`asRecord` accepts plain objects. `asObjectRecord` also accepts class and built-in
object instances; both reject arrays and null. `asObjectRecordOrUndefined` is
the optional loose variant, and `hasPlainObjectTag` checks the object tag.

Restart requests require a host-installed handler; otherwise they throw
`RESTART_HANDLER_NOT_INSTALLED`. Self-edit defaults to the host process
environment and retains its explicit opt-in and production gates.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/core build  # build
bun run --cwd packages/core test   # tests
```

View declaration types remain in core; browser-safe visibility and surface-policy
helpers live in `@elizaos/core/views/*`; renderers import those leaves directly.
