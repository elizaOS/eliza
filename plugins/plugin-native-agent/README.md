# @elizaos/capacitor-agent

Capacitor plugin for managing an embedded Eliza agent runtime from a WebView-based app. Provides a uniform `Agent.*` JavaScript API across iOS, Android, and web/desktop, with platform-specific native bridges and an HTTP-based web fallback.

## What it does

- **Start / stop** the agent runtime and poll its state.
- **Send chat messages** (DM channel) and receive agent replies.
- **Forward arbitrary HTTP requests** to the local agent API server via a path-only bridge.
- **Read the per-boot bearer token** on Android local deployments.

The plugin handles three deployment shapes automatically:

| Platform | Mechanism |
|---|---|
| iOS remote/cloud | HTTP to a configured API endpoint (reads `ELIZA_IOS_API_BASE` or equivalent) |
| iOS local / sideload | WebView ITTP bridge (`window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__`) |
| Android local | Reflection call into `ElizaAgentService` in the host app |
| Web / Electrobun | HTTP fetch to `window.__ELIZA_API_BASE__` or relative URLs |

## Capacitor methods

```typescript
import { Agent } from "@elizaos/capacitor-agent";

// Start the agent
const status = await Agent.start({ mode: "cloud" });

// Get status
const status = await Agent.getStatus();
// status.state: "not_started" | "starting" | "running" | "stopped" | "error"

// Chat
const reply = await Agent.chat({ text: "Hello" });
// reply.text, reply.agentName

// Forward a request
const result = await Agent.request({
  path: "/api/status",
  method: "GET",
  timeoutMs: 5000,
});

// Stop the agent
await Agent.stop();

// Read local agent token (Android only)
const { available, token } = await Agent.getLocalAgentToken();
```

## Installation

This is a Capacitor plugin distributed as part of the elizaOS monorepo. Add it as a dependency in your Capacitor app, then run `npx cap sync` to install the native modules.

```bash
npm install @elizaos/capacitor-agent
npx cap sync
```

### iOS (CocoaPods)

The pod is named `ElizaosCapacitorAgent`. It is registered automatically via `capacitor.config` after `pod install`. Minimum deployment target: **iOS 13.0** (note: local ITTP mode requires iOS 14+).

### Android

The plugin is registered automatically. The host app must implement `ElizaAgentService` and register it in `AndroidManifest.xml`. The plugin locates it via reflection (no direct Gradle dependency).

## Configuration

### iOS endpoint (remote/cloud mode)

Set one of the following in your `capacitor.config.json` (under the `Agent` plugin key), `Info.plist`, or environment:

- `ELIZA_AGENT_API_BASE` / `ELIZA_IOS_API_BASE` / `ELIZA_MOBILE_API_BASE` — HTTP/HTTPS base URL of the agent API server
- `ELIZA_AGENT_API_TOKEN` / `ELIZA_IOS_API_TOKEN` / `ELIZA_MOBILE_API_TOKEN` — optional bearer token
- `ELIZA_IOS_RUNTIME_MODE` / `VITE_ELIZA_IOS_RUNTIME_MODE` — set to `local` / `ios-local` / `sideload-local` to activate local ITTP mode instead of HTTP

Example `capacitor.config.json` fragment:
```json
{
  "plugins": {
    "Agent": {
      "apiBase": "https://your-eliza-host.example.com",
      "apiToken": "your-bearer-token"
    }
  }
}
```

### Web / Electrobun

- `window.__ELIZA_API_BASE__` — API server base URL; falls back to relative URLs on `http:`/`https:` origins.
- `window.__ELIZA_API_TOKEN__` — bearer token; falls back to `sessionStorage.eliza_api_token`.

## Exported types

```typescript
interface AgentStatus {
  state: "not_started" | "starting" | "running" | "stopped" | "error";
  agentName: string | null;
  port: number | null;
  startedAt: number | null; // epoch ms
  error: string | null;
}

interface ChatResult {
  text: string;
  agentName: string;
}

interface AgentStartOptions {
  apiBase?: string;
  mode?: "remote-mac" | "cloud" | "cloud-hybrid" | "local" | string;
}

interface AgentRequestOptions {
  path: string;       // must start with /, not an absolute URL
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}

interface AgentRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}
```

## Building

```bash
bun run --cwd plugins/plugin-native-agent build   # tsc + rollup → dist/
bun run --cwd plugins/plugin-native-agent watch   # tsc --watch
```

## Limitations

- `Agent.request` only accepts path-only URLs (must start with `/`). Absolute URLs are rejected by all implementations.
- Request and response bodies are capped at 10 MB.
- iOS local mode (`Agent.chat` / `Agent.request` via ITTP) requires `window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__` to be installed by the host WebView. If it is absent, a 503 is returned.
- The Android bridge uses reflection; renaming or unregistering `ElizaAgentService` breaks all Android calls silently at runtime.
- The `chat` method maintains one conversation per session (lazily created via `POST /api/conversations`). The conversation ID is not persisted across app restarts.
