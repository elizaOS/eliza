# Coding-agent UI module

This module belongs to `@elizaos/plugin-agent-orchestrator`; follow its
[guide](../AGENTS.md) and the [repository guide](../../../AGENTS.md).

`../src/ui/plugin.ts` declares the task-coordinator, orchestrator and cockpit view
manifests. The Node plugin consumes that metadata without importing React.
`../src/ui/register.ts` registers signed native pages and UI slots; browser hosts
import `@elizaos/plugin-agent-orchestrator/ui/register` explicitly.

Keep view IDs, route paths, capability authority and component exports aligned
between the manifest, native registration and view bundle. Task/session state
belongs to the parent plugin's services. No slash command is required.

From the parent package run `build:ui`, `test:ui` and `typecheck:ui`.
The UI bundle is emitted to `dist/views/bundle.js`; browser subpath modules
and declarations are emitted to `dist/ui/`. React and shared UI remain host
externals. Native clients must retain their signed in-bundle page loaders.
