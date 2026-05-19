# Capability Router Remote Plugins

This document is the working architecture record for dynamic plugin modules
served from another process, device, or cloud sandbox.

The canonical abstraction is **capability router**. A satellite is one possible
provider/deployment shape, not the universal name. The agent should depend on a
small protocol and runtime service, while E2B, home devices, mobile companion
processes, Eliza Cloud containers, and future sandbox providers are endpoints
behind that service.

## Goal

An agent runtime must be able to use a plugin whose executable code is not
written into the local app bundle. This is required for App Store and mobile
targets, cloud agents using local device capabilities, local agents using cloud
sandboxes, and coding-agent built plugins that should become available without
changing the agent process code.

Remote modules must be able to contribute the same plugin surface the runtime
already understands:

- actions
- providers
- HTTP routes
- compiled frontend views
- route/view metadata sufficient for discovery and unload

The local runtime remains responsible for plugin ownership, registration,
unload/reload, provider/action selection, route dispatch, and view registry
integration. Remote code is invoked over the capability-router protocol.

## Canonical Contract

The current protocol is intentionally small:

```text
GET  /v1/capabilities
POST /v1/capabilities/invoke
```

`GET /v1/capabilities` returns availability across the canonical capability
families:

```json
{
  "environment": "server",
  "available": true,
  "capabilities": {
    "fs": true,
    "pty": true,
    "git": true,
    "model": false,
    "plugin": true
  }
}
```

`POST /v1/capabilities/invoke` uses:

```json
{
  "method": "plugin.action.invoke",
  "params": {
    "moduleId": "cloud-tools",
    "action": "SUMMARIZE",
    "content": {},
    "options": {}
  }
}
```

Responses are either:

```json
{ "ok": true, "result": {} }
```

or:

```json
{
  "ok": false,
  "error": {
    "code": "CAPABILITY_UNAVAILABLE",
    "message": "not granted",
    "capability": "plugin",
    "method": "plugin.action.invoke"
  }
}
```

The standard methods currently implemented in core are:

| Method                       | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `fs.list`                    | List files in a routed workspace or device namespace.     |
| `fs.readText`                | Read a text file through the provider.                    |
| `fs.writeText`               | Write a text file through the provider.                   |
| `pty.command.run`            | Run a command through a routed terminal provider.         |
| `git.status`                 | Get repository status through the provider.               |
| `git.diff`                   | Get repository diff through the provider.                 |
| `git.command.run`            | Run a git command through the provider.                   |
| `model.status`               | Report local model availability where supported.          |
| `plugin.modules.list`        | List remote plugin module manifests.                      |
| `plugin.action.invoke`       | Invoke a remote action contribution.                      |
| `plugin.provider.get`        | Invoke a remote provider contribution.                    |
| `plugin.evaluator.shouldRun` | Invoke a remote evaluator activation check.               |
| `plugin.evaluator.prepare`   | Prepare remote evaluator prompt context.                  |
| `plugin.evaluator.process`   | Process remote evaluator model output.                    |
| `plugin.event.handle`        | Invoke a remote plugin event handler.                     |
| `plugin.model.invoke`        | Invoke a remote JSON-serializable model handler.          |
| `plugin.appBridge.call`      | Invoke a JSON-safe remote app bridge hook.                |
| `plugin.route.call`          | Invoke a remote route contribution.                       |
| `plugin.asset.get`           | Fetch remote plugin assets when direct URLs are not used. |

## Remote Module Manifest

`plugin.modules.list` returns:

```json
{
  "modules": [
    {
      "id": "device-tools",
      "name": "@remote/device-tools",
      "version": "1.0.0",
      "description": "Device-backed tools",
      "actions": [
        {
          "name": "DEVICE_PING",
          "description": "Ping the device"
        }
      ],
      "providers": [
        {
          "name": "DEVICE_CONTEXT",
          "description": "Device context"
        }
      ],
      "evaluators": [
        {
          "name": "DEVICE_RECAP",
          "description": "Evaluate whether device state should be recapped.",
          "prompt": "Return {\"shouldRecap\": true} when the device state should be recapped.",
          "schema": {
            "type": "object",
            "properties": {
              "shouldRecap": { "type": "boolean" }
            }
          },
          "hasPrepare": true,
          "hasProcessor": true
        }
      ],
      "events": [
        {
          "eventName": "DEVICE_STATE_CHANGED"
        }
      ],
      "models": [
        {
          "modelType": "DEVICE_TEXT",
          "priority": 75
        }
      ],
      "widgets": [
        {
          "id": "device.status",
          "slot": "chat-sidebar",
          "label": "Device Status",
          "icon": "PanelRight",
          "order": 40,
          "defaultEnabled": true
        }
      ],
      "app": {
        "displayName": "Device Tools",
        "category": "tool",
        "launchType": "url",
        "launchUrl": "https://device.example/app",
        "icon": "PanelRight",
        "capabilities": ["device"],
        "viewer": {
          "url": "https://device.example/viewer",
          "embedParams": {
            "mode": "device"
          },
          "postMessageAuth": true
        },
        "session": {
          "mode": "viewer",
          "features": ["commands"]
        },
        "navTabs": [
          {
            "id": "device.status",
            "label": "Device Status",
            "path": "/device",
            "icon": "PanelRight"
          }
        ]
      },
      "appBridge": {
        "hooks": [
          "prepareLaunch",
          "resolveViewerAuthMessage",
          "collectLaunchDiagnostics",
          "resolveLaunchSession",
          "refreshRunSession",
          "stopRun",
          "handleAppRoutes"
        ]
      },
      "routes": [
        {
          "method": "POST",
          "path": "/device/ping",
          "public": true,
          "name": "device-ping"
        }
      ],
      "views": [
        {
          "id": "device.panel",
          "label": "Device Panel",
          "viewType": "gui",
          "bundleUrl": "https://device.example/assets/device-panel.js"
        }
      ]
    }
  ]
}
```

The manifest is structural. Runtime behavior must not depend on prompt text.
`module.id` is the remote routing key; `module.name` is the local plugin name
registered into the runtime lifecycle.

Manifest decoding is strict at the capability-router boundary:

- `module.id`, `module.name`, action `name`, action `description`, provider
  `name`, evaluator `name`, evaluator `description`, evaluator `prompt`, model
  `modelType`, widget `id`, widget `label`, route `path`, view `id`, and view
  `label` must be non-empty strings.
- Route `method` must be one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or
  `STATIC`.
- View `viewType`, when present, must be `gui` or `tui`.
- `actions`, `providers`, `evaluators`, `events`, `models`, `widgets`,
  `routes`, and `views`, when present, must be arrays.
- Event `eventName` must be a non-empty string.
- Widget `slot` must be one of the core `PluginWidgetDeclaration` slots.
- App `viewer.url` and nav tab `id`, `label`, and `path` must be non-empty
  strings when present. App session `mode` and `features` are validated against
  the core plugin app unions.
- App bridge `hooks` must be a non-empty list of JSON-safe bridge hooks:
  `prepareLaunch`, `resolveViewerAuthMessage`, `ensureRuntimeReady`,
  `collectLaunchDiagnostics`, `resolveLaunchSession`, `refreshRunSession`, and
  `stopRun`. `handleAppRoutes` is supported through an HTTP-style JSON envelope
  containing `method`, `pathname`, `path`, `query`, `headers`, and optional
  `body`; the remote side returns `{ handled, status, headers, body }`, which
  the local adapter writes back to the response object.
- Model `priority`, when present, must be a finite number. Remote model calls
  currently support JSON-serializable params/results through
  `plugin.model.invoke`; streaming and binary model payloads still need a
  separate transport story before they can be called complete.
- Evaluator `schema` is required and must be a JSON object. Evaluator `prompt`
  is manifest data because the current core evaluator interface expects
  synchronous prompt generation; async remote work belongs in `shouldRun`,
  `prepare`, and `process`.
- `metadata`, when present, must be a JSON object.
- `bundlePath` and `bundleUrl`, when present, must be non-empty strings.

Relative remote `bundlePath` values are normalized by the agent-side router to
absolute `bundleUrl` values rooted at the endpoint that advertised the module.
The canonical asset URL is:

```text
GET /v1/capabilities/assets/:moduleId/<asset-path>
```

The capability server resolves that request through `plugin.asset.get` and
returns the decoded asset bytes with the declared content type. Local plugins
should continue to use `bundlePath`.

## Runtime Integration

The runtime path is:

```text
RemoteCapabilityRouterService
  -> plugin.modules.list
  -> createRemoteCapabilityPlugin(module)
  -> runtime.registerPlugin(plugin)
  -> existing lifecycle ownership / route dispatch / view registry
```

Remote actions, providers, evaluators, events, models, and routes are thin proxy
contributions. They keep the runtime-local registration shape, then call back
through `getCapabilityRouter(runtime)` when executed.

This is deliberate. It avoids a second plugin primitive and lets unload/reload
use existing plugin ownership bookkeeping.

## Multi-Endpoint Routing

`ELIZA_CAPABILITY_ROUTER_URL` configures a primary endpoint.

`ELIZA_CAPABILITY_ROUTER_URLS` configures multiple endpoints. It accepts either
a comma-separated list:

```text
ELIZA_CAPABILITY_ROUTER_URLS=https://device.example,https://cloud.example
```

or a JSON array:

```json
[
  { "id": "device", "baseUrl": "https://device.example", "token": "..." },
  { "id": "cloud", "baseUrl": "https://cloud.example", "token": "..." }
]
```

When multiple endpoints are configured:

- `plugin.modules.list` is aggregated across endpoints.
- `module.id` must be unique across all endpoints.
- action/provider/route/asset calls are routed back to the endpoint that
  advertised the module.
- low-level `fs`, `pty`, `git`, and `model.status` calls use the primary
  endpoint by default, or a specific endpoint when callers pass `endpointId`.

## Why Not "Satellite" As The Abstraction

PR #7779 uses the word "satellite" for several different concerns:

- an Electrobun-packaged companion process,
- a cloud/home HTTP runner,
- low-level `fs`/`pty`/`git` capability execution,
- runtime route proxying,
- dynamic frontend view hosting,
- coding-agent sandbox execution.

That naming makes product/provider decisions look like runtime architecture.
It also makes non-satellite cases awkward: an iOS app talking to Eliza Cloud, a
cloud agent talking to a home device, or a local agent using an E2B sandbox are
all capability-router cases whether or not the provider is called a satellite.

Keep `satellite` for a concrete deployment target when useful. Use
`capability-router` for the runtime abstraction and protocol.

## Critical Assessment Of PR #7779

Useful ideas to keep:

- The same core need is correctly identified: route code execution and dynamic
  capabilities outside the constrained agent bundle.
- The first-party runner set covers important provider families: cloud,
  user-owned home machine, local desktop/mobile companion, and sandbox.
- It treats filesystem, terminal, git, and remote runtime capabilities as
  routed operations rather than local assumptions.
- It includes live-smoke thinking for provider credentials and sandbox paths.
- It recognizes compiled views as part of the plugin surface, not a separate
  UI-only mechanism.

Problems to avoid:

- The PR is too broad to merge as-is; it changes many platforms, workflows,
  generated assets, and provider packages at once.
- "Satellite" is overloaded and leaks provider/deployment names into runtime
  API names.
- It creates multiple provider-specific contracts instead of one canonical
  invoke contract.
- Some behavior is coupled to specific platforms and packaging directories,
  making the universal plugin story harder to reason about.
- It does not clearly separate remote plugin manifests from lower-level coding
  sandbox capabilities.

Current extraction strategy:

- Keep the single `ElizaCapabilityRouter` service in core.
- Keep one HTTP protocol for all endpoints.
- Map remote modules into normal `Plugin` objects.
- Let existing runtime ownership manage unload/reload.
- Treat cloud/home/E2B/mobile/desktop companion as endpoint providers behind
  the protocol.

## Implemented Evidence

Current local implementation includes:

- Core capability-router types in `packages/core/src/capabilities`.
- Core exports from node, browser, and edge entrypoints.
- Agent HTTP client/server bridge in
  `packages/agent/src/services/remote-capability-router.ts`.
- Agent cloud sandbox endpoint provisioner in
  `packages/agent/src/services/remote-capability-cloud-sandbox.ts`.
- Agent API route `POST /api/capability-router/connect` that installs an
  already-provisioned endpoint or provisions a Cloud endpoint, then syncs remote
  plugins without returning stored tokens.
- Restart persistence for connected endpoints: redacted endpoint metadata is
  saved in `eliza.json`, while token-bearing `ELIZA_CAPABILITY_ROUTER_URLS`
  lives in the existing `config.env` secret channel and is re-applied to
  `process.env` on startup.
- `elizaos capability-router connect` CLI command for calling that agent API
  against direct endpoints or Cloud provisioning flows.
- Remote manifest to `Plugin` adapter in
  `packages/agent/src/services/remote-plugin-adapter.ts`.
- Startup sync in `packages/agent/src/runtime/eliza.ts`.
- Remote `bundleUrl` support in the view registry.
- Multi-endpoint plugin aggregation and endpoint-specific invocation routing.
- Explicit `endpointId` routing for low-level `fs`, `pty`, `git`, and
  `model.status` capabilities.

Current focused tests cover:

- core method validation and error decoding,
- HTTP request/response round trips,
- fetch-handler server contract,
- remote module manifests,
- action/provider/evaluator/event/model/route proxying,
- remote widget declarations on the normal `plugin.widgets` field,
- remote app metadata and nav tabs on the normal `plugin.app` field,
- remote JSON-safe app bridge hooks through a runtime route-module registry,
- skip/reload/unload sync behavior,
- multiple remote endpoints,
- low-level capability routing to explicit endpoint ids,
- cloud sandbox provisioning normalization from Cloud create/provision/job
  responses into capability-router endpoint configs,
- cloud sandbox connection helper that installs the returned endpoint into the
  runtime capability-router service and syncs remote modules through normal
  plugin ownership,
- authenticated agent route for direct endpoint connection or Cloud
  provisioning, including token redaction in API responses,
- endpoint persistence that preserves restart reload without serializing
  endpoint tokens into `eliza.json`,
- CLI payload construction for direct endpoint and Cloud provisioning flows,
- duplicate module ID rejection,
- real localhost HTTP capability-server integration,
- no-credential source-build smoke: a temporary remote plugin source tree builds
  a browser bundle, serves a manifest/action/provider/route/assets over the
  capability protocol, then bootstraps into the runtime without local plugin
  registration code,
- no-credential process-isolation smoke: a built remote plugin runs from a
  separate child-process capability server and is consumed through HTTP only,
- opt-in Docker/container smoke: a built remote plugin is packaged into a real
  Docker container, exposed as a capability server, and consumed through the
  same runtime path (`bun run test:remote-capabilities:docker`),
- remote route dispatch through the actual API route dispatcher,
- remote frontend bundle URL normalization,
- browser-facing view registry and `/api/views` metadata for remote absolute
  bundle URLs,
- app-shell `DynamicViewLoader` behavior for absolute remote bundle URLs,
  including direct bundle import and remote view `interact` handler
  registration.

Run the no-credential CI slice with:

```text
bun run test:remote-capabilities
```

Run the container-backed live smoke with Docker available:

```text
bun run test:remote-capabilities:docker
```

## Remaining Work Before This Is "Done"

This is not complete until the following are true:

- A real isolated sandbox provider can build a plugin from source, serve its
  manifest and compiled frontend bundle, and expose action/provider/route
  handlers through the capability-router protocol. The no-credential local
  source-build and child-process smokes prove the protocol and process-boundary
  paths; the opt-in Docker smoke proves local container isolation when enabled.
- The agent can create or connect to that sandbox from normal product flows.
  The agent-side provisioner, API route, and CLI can now connect/sync returned
  endpoints into a runtime with restart persistence; product UI wiring still
  needs to expose the flow.
- Auth is specified and enforced for endpoint registration, invocation, and
  frontend asset access.
- Endpoint identity, module identity, and route namespace collision rules are
  final.
- Remote view loading is covered through the browser-facing view registry
  metadata path, real compiled bundle fetch/evaluation smokes, and app-shell
  loader unit coverage; a Playwright/browser E2E against a running app shell
  and remote capability server is still needed.
- CI runs focused remote-capability tests and at least one process-level smoke
  without external credentials.
- Credentialed CI or nightly smoke covers at least one real cloud sandbox
  provider beyond local Docker.
- The old satellite-specific names are either removed from canonical APIs or
  kept only as compatibility aliases.
