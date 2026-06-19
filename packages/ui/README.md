# @elizaos/ui

Shared UI primitives, composites, and layout utilities for elizaOS apps.

`@elizaos/ui` is the design system and front-end runtime glue used across the
elizaOS ecosystem. It bundles the React component library, the agent dashboard
shell, a typed HTTP/WebSocket API client for the agent runtime, the
agent-surface layer that makes plugin views controllable by the agent, GenUI,
voice, theming, i18n, and platform/bridge integration for web, desktop
(Electrobun), and mobile (Capacitor).

## Who uses it

It is imported by the elizaOS web and desktop app, the cloud frontend, the
marketing/OS homepages, and many plugin UI packages. React and react-dom are
peer dependencies — the host application owns the React instance.

## Install

```bash
bun add @elizaos/ui
```

Requires `react` and `react-dom` `19.2.5` as peer dependencies.

## Usage

Import components and utilities from the root barrel or, preferably, from a
subpath to keep bundles lean:

```tsx
import { Button } from "@elizaos/ui/button";
import { ElizaClient } from "@elizaos/ui/api";
import { useMediaQuery } from "@elizaos/ui/hooks";
import "@elizaos/ui/styles"; // default stylesheets (renderer only)
```

Cloud-frontend components live under a dedicated subpath:

```tsx
import { DashboardActionCards } from "@elizaos/ui/cloud-ui";
import "@elizaos/ui/cloud-ui/index.css";
```

Stylesheets are intentionally separate from the JS barrel so Node-side plugin
loaders can import `@elizaos/ui` without evaluating CSS. Import
`@elizaos/ui/styles` explicitly from the renderer.

## Notable subsystems

- **API client** (`@elizaos/ui/api`) — `ElizaClient` plus per-domain client
  modules for agents, chat, cloud, automations, and more.
- **Agent surface** (re-exported from `@elizaos/ui`) — `useAgentElement` and the
  provider/overlay that let the agent address, focus, fill, and click view
  elements. See `src/agent-surface/README.md`.
- **GenUI** (`@elizaos/ui/genui`) — declarative, agent-generated UI (an
  A2UI-compatible subset). See `src/genui/README.md`.
- **Config** (`@elizaos/ui/config`) — boot config, branding, and the
  plugin-config UI-spec engine.
- **Registries** — `registerAppShellPage` for runtime nav tabs, the widget and
  overlay-app registries, and `registerProviderLogo`.

## Development

```bash
bun run --cwd packages/ui build       # build the publishable dist/
bun run --cwd packages/ui typecheck
bun run --cwd packages/ui test
bun run --cwd packages/ui lint
bun run --cwd packages/ui stories:dev # component stories
```

This is a library; there is no standalone dev server — run it through a host app.

