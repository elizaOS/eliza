---
title: Apps Overview
sidebarTitle: Overview
description: Eliza ships as a cross-platform suite for desktop, mobile, and web dashboard workflows.
---

Eliza is available across all primary platforms. Each app connects to the same agent runtime, giving you a consistent experience whether you're at your desk or on your phone.

## Available Apps

<CardGroup cols={2}>

<Card title="Desktop App" icon="desktop" href="/apps/desktop">
  Electrobun-based desktop app for macOS, Windows, and Linux with native OS integration and embedded runtime.
</Card>

<Card title="Mobile App" icon="mobile" href="/apps/mobile">
  iOS and Android app built with Capacitor, featuring native plugins and push notifications.
</Card>

<Card title="Dashboard" icon="browser" href="/apps/dashboard">
  Web-based management interface for agent configuration, monitoring, and analytics.
</Card>


</CardGroup>

## Architecture

All apps share a common connection pattern:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Desktop App │     │  Mobile App  │     │   Dashboard  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────┬───────┴──────────────┬─────┘
                    │                      │
              ┌─────▼──────┐         ┌────▼──────┐
              │  Agent API  │         │  Runtime  │
              │  (REST/WS)  │         │  Services │
              └─────────────┘         └───────────┘
```

- **Desktop** embeds the runtime directly (offline-capable)
- **Mobile** connects via REST API
- **Dashboard** uses REST + WebSocket for real-time updates

## Standalone Apps vs. App Plugins

Eliza has two distinct types of "apps" — understanding the difference prevents confusion.

### Standalone Apps (Platforms)

These are the independent applications listed above. Each is a complete, pre-built application that connects to the agent runtime. You install them once and they provide the UI for interacting with your agent.

### App Plugins (Game/Experience Apps)

These are elizaOS plugins with names like `@hyperscape/plugin-hyperscape` that are installed through the Dashboard's **Apps** browser. When launched:

1. The plugin is installed into the agent runtime
2. The agent connects to an external service (e.g., a metaverse, a game server)
3. The Dashboard embeds the service UI in a **sandboxed iframe**
4. The agent can interact with the service alongside you

```
┌─────────────────────────────────────┐
│  Dashboard                          │
│  ┌─────────────────────────────┐    │
│  │  iframe (sandboxed)         │    │
│  │  ┌───────────────────────┐  │    │
│  │  │  External Service UI  │  │    │
│  │  │  (e.g., Hyperscape)   │  │    │
│  │  └───────────────────────┘  │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │  Agent Logs Panel           │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

App plugins are discovered via the [Plugin Registry](/plugins/registry) and filtered by the `app-` prefix in their package name. They are managed through the [Apps API](/rest/apps).

<Note>
Plugins do **not** inject custom UI components into the Dashboard. Plugin configuration uses schema-driven forms (via `@elizaos/plugin-ui`), not dynamically loaded components. Only app plugins with a `viewer.url` get embedded as iframes.
</Note>

### Key Differences

| | Standalone Apps | App Plugins |
|---|---|---|
| **What they are** | Pre-built platform clients | Plugins that connect to external services |
| **How you get them** | Install once (binary/extension) | Install from Apps browser in Dashboard |
| **UI location** | Independent window/app | Embedded iframe in Dashboard |
| **Runtime relationship** | Connects to runtime via API | Runs inside the runtime as a plugin |
| **Examples** | Desktop, Mobile, Dashboard | Hyperscape, 2004scape |
| **Package naming** | N/A | `@elizaos/app-*` |

## Choosing a Standalone App

| Need | Best App |
|------|----------|
| Full offline capability | Desktop |
| On-the-go access | Mobile |
| Browser automation | Desktop or Dashboard with browser-capable plugins |
| Team management | Dashboard |

## Related

- [Installation](/installation) — Install the CLI and apps
- [Configuration](/configuration) — Configure your agent
- [Quickstart](/quickstart) — Get started in minutes
- [Apps API](/rest/apps) — REST API for managing app plugins
- [Plugin Registry](/plugins/registry) — Browse available plugins and apps
