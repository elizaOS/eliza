---
title: Apps
sidebarTitle: Apps
description: Browse, launch, and manage apps and games that integrate with your Eliza agent from the in-dashboard app browser.
---

The Apps tab provides a built-in app browser for discovering, launching, and managing applications that integrate with your agent. Access it from the main dashboard navigation at `/apps`.

## App Browser

The browser displays apps from the registry as a searchable, filterable grid of cards. Each card shows the app's display name, category badge, active/inactive status, description, and a launch button.

### Search and Filter

- **Search** — filter apps by name, display name, or description
- **Active Only toggle** — show only currently running apps
- **Active count badge** — shows how many apps are currently running

### App Categories

| Category | Description |
|----------|-------------|
| `game` | Interactive games the agent can play |
| `social` | Social platform integrations |
| `platform` | Platform and infrastructure apps |
| `world` | Virtual world environments |

## Launching Apps

Click **Launch** on any app card to start it. The launch behavior depends on the app's configuration:

1. **Viewer URL available** — the app opens in full-screen Game View within the dashboard
2. **Launch URL only** — the app opens in a new browser tab
3. **Neither** — an error notice is displayed

If an app is already running, an **Active Session** banner appears above the app list with options to resume full-screen or open in a new tab.

## App Detail Page

Click the arrow on any app card to open the detail view:

- **Metadata** — launch type, latest version, launch URL, repository link
- **Capabilities** — tags describing what the app can do
- **Viewer config** — URL, postMessage auth status, sandbox policy
- **Hyperscape Controls** — for `@hyperscape/plugin-hyperscape` apps, an expandable panel with embedded agent management, messaging, commands, and goal tracking

## Game View

When an app with a viewer URL is launched, it opens in the **Game View** — a full-screen iframe that fills the entire Apps tab area.

### Game View Header

| Control | Description |
|---------|-------------|
| **App name** | Display name of the running app |
| **Connection status** | `Connecting` (yellow), `Connected` (green), or `Disconnected` (red) |
| **Show/Hide Logs** | Toggle the agent logs panel |
| **Keep on Top** | Pin app as a floating overlay when navigating other tabs |
| **Open in New Tab** | Open the app viewer URL in a separate browser tab |
| **Stop** | Stop the app and return to the browser |
| **Back to Apps** | Return to browser without stopping the app |

### Agent Logs Panel

Toggle the logs panel to see a split-screen view with the last 50 agent log entries filtered for the current app. The panel includes a chat input for sending commands directly to the agent (e.g., "go chop wood", "attack the goblin").

### Floating Overlay

When **Keep on Top** is enabled, the game renders as a 480x360 draggable, resizable overlay window pinned to the bottom-right corner. The overlay persists across tab navigation, letting you monitor the game while working in other parts of the dashboard.

- **Drag** the title bar to reposition
- **Resize** using the CSS resize handle
- **Expand** to return to full-screen Game View
- **Close** to dismiss the overlay (does not stop the game)
