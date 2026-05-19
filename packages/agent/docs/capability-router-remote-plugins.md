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
- evaluators
- response-handler evaluators
- response-handler field evaluators
- lifecycle hooks
- event handlers
- JSON-safe model handlers
- JSON-safe service methods
- HTTP routes
- app bridge hooks
- compiled frontend views
- component type, context, widget, app, route, view, config, schema, priority,
  and metadata sufficient for discovery, registration, reload, and unload

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

| Method                                           | Purpose                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| `fs.list`                                        | List files in a routed workspace or device namespace.     |
| `fs.readText`                                    | Read a text file through the provider.                    |
| `fs.writeText`                                   | Write a text file through the provider.                   |
| `pty.command.run`                                | Run a command through a routed terminal provider.         |
| `git.status`                                     | Get repository status through the provider.               |
| `git.diff`                                       | Get repository diff through the provider.                 |
| `git.command.run`                                | Run a git command through the provider.                   |
| `model.status`                                   | Report local model availability where supported.          |
| `plugin.modules.list`                            | List remote plugin module manifests.                      |
| `plugin.action.invoke`                           | Invoke a remote action contribution.                      |
| `plugin.provider.get`                            | Invoke a remote provider contribution.                    |
| `plugin.evaluator.shouldRun`                     | Invoke a remote evaluator activation check.               |
| `plugin.evaluator.prepare`                       | Prepare remote evaluator prompt context.                  |
| `plugin.evaluator.prompt`                        | Resolve the remote evaluator model prompt.                |
| `plugin.evaluator.process`                       | Process remote evaluator model output.                    |
| `plugin.responseHandlerEvaluator.shouldRun`      | Invoke a response-handler evaluator activation check.     |
| `plugin.responseHandlerEvaluator.evaluate`       | Evaluate a response-handler event remotely.               |
| `plugin.responseHandlerFieldEvaluator.shouldRun` | Invoke a response-handler field activation check.         |
| `plugin.responseHandlerFieldEvaluator.parse`     | Parse a response-handler field value remotely.            |
| `plugin.responseHandlerFieldEvaluator.handle`    | Apply a parsed response-handler field remotely.           |
| `plugin.lifecycle.call`                          | Invoke a remote plugin lifecycle hook.                    |
| `plugin.event.handle`                            | Invoke a remote plugin event handler.                     |
| `plugin.model.invoke`                            | Invoke a remote JSON-serializable model handler.          |
| `plugin.service.call`                            | Invoke a JSON-safe remote service method.                 |
| `plugin.appBridge.call`                          | Invoke a JSON-safe remote app bridge hook.                |
| `plugin.route.call`                              | Invoke a remote route contribution.                       |
| `plugin.asset.get`                               | Fetch remote plugin assets when direct URLs are not used. |

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
      "config": {
        "DEVICE_MODE": "production",
        "maxRetries": 2,
        "enabled": true
      },
      "schema": {
        "device_records": {
          "id": "uuid",
          "status": "text"
        }
      },
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
      "responseHandlerEvaluators": [
        {
          "name": "DEVICE_RESPONSE_CHECK",
          "description": "Evaluate whether a response handler should run.",
          "priority": 20
        }
      ],
      "responseHandlerFieldEvaluators": [
        {
          "name": "device_status",
          "description": "Parse and apply device status fields.",
          "priority": 20,
          "schema": {
            "type": "object",
            "properties": {
              "status": { "type": "string" }
            }
          },
          "hasParse": true,
          "hasHandle": true
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
      "services": [
        {
          "serviceType": "device_service",
          "capabilityDescription": "Remote device service",
          "methods": ["lookup", "stop"],
          "config": {
            "region": "device"
          }
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
      "lifecycle": {
        "hooks": ["init", "dispose", "applyConfig"]
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
`module.id` is the remote routing key and must use only letters, numbers,
dots, underscores, or hyphens. Colons are reserved for the live/conformance
`moduleId:target` notation, and path/query separators are not valid module
identity. `module.name` is the local plugin name registered into the runtime
lifecycle.

Manifest decoding is strict at the capability-router boundary:

- `module.id` must be a valid remote module identifier. `module.name`, action
  `name`, action `description`, provider `name`, evaluator `name`, evaluator
  `description`, evaluator `prompt`, model `modelType`, widget `id`, widget
  `label`, route `path`, view `id`, and view `label` must be non-empty
  strings.
- Route `method` must be one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or
  `STATIC`. The remote plugin adapter currently rejects remote `STATIC` routes
  because local route dispatch skips static routes and there is no remote static
  mount contract yet; compiled frontend bundles and other remote files should
  use `views` plus `plugin.asset.get`.
- Route `path` and app nav tab `path` must be local absolute app paths. They
  must not include a URL scheme, query, hash, backslash, empty segment, `.`
  segment, or `..` segment.
- View `viewType`, when present, must be `gui` or `tui`.
- `actions`, `providers`, `evaluators`, `events`, `models`, `widgets`,
  `routes`, and `views`, when present, must be arrays.
- `config`, when present, must be an object whose values are strings, numbers,
  booleans, or null. It is materialized on the normal local `plugin.config`
  field, with local ownership keys such as `remoteCapabilityModuleId`,
  `remoteCapabilityEndpointId`, and `remoteCapabilityVersion` reserved for the
  adapter.
- `schema`, when present, must be a JSON object. It is materialized on the
  normal local `plugin.schema` field so provisioning and
  `runtime.runPluginMigrations()` can use the existing plugin migration path for
  remote modules.
- Event `eventName` must be a non-empty string.
- Widget `slot` must be one of the core `PluginWidgetDeclaration` slots.
- App `viewer.url` and nav tab `id`, `label`, and `path` must be non-empty
  strings when present. Remote app `viewer.url` and string `launchUrl` values
  must be absolute `http` or `https` URLs without embedded credentials. App
  session `mode` and `features` are validated against the core plugin app
  unions.
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
  separate transport story before they can be called complete. Multiple remote
  modules may contribute handlers for the same model type through the normal
  runtime model stack, but one remote module cannot declare the same model type
  twice because a local `Plugin.models` object has only one handler per key.
- Services can be declared with `serviceType`, optional
  `capabilityDescription`, optional `methods`, and optional JSON-object
  `config`. The local adapter registers a normal `Plugin.services` class whose
  `start` method returns a service instance; declared methods proxy
  `plugin.service.call` with JSON-safe args/results. `stop` is proxied only when
  listed in `methods`; otherwise service stop is a local no-op. Service types
  are global runtime lookup keys, so remote manifests are rejected when two
  remote modules declare the same service type or when a remote service would
  collide with an existing local runtime service outside a reload of an
  adapter-owned remote plugin. Service `methods`, when present, must be valid,
  unique JavaScript method identifiers and cannot use reserved local service
  method names such as `callRemote`, `constructor`, or prototype built-ins.
- Remote view ids are registry keys scoped by `viewType`. The adapter rejects
  duplicate remote view keys in a sync batch and rejects remote views that would
  collide with existing local runtime views outside a reload of an adapter-owned
  remote plugin, so compiled frontend entries are not silently dropped by the
  view registry.
- Remote widget ids are registry keys scoped by `pluginId/id`, where omitted
  `pluginId` defaults to the remote plugin name. The adapter rejects duplicate
  remote widget keys in a sync batch and rejects remote widgets that would
  collide with existing local runtime widgets outside a reload of an
  adapter-owned remote plugin.
- Remote app nav tab ids are shell navigation keys. The adapter rejects
  duplicate remote nav tab ids in a sync batch and rejects remote nav tabs that
  would collide with existing local runtime nav tabs outside a reload of an
  adapter-owned remote plugin.
- Remote app bridge identifiers are registered under normalized app route keys.
  The adapter rejects duplicate remote app bridge keys in a sync batch and
  rejects remote bridge keys that would collide with existing runtime app route
  modules before plugin initialization, so one remote app bridge cannot replace
  another route module in the runtime app route-module registry.
- Evaluator `schema` is required and must be a JSON object. Evaluator `prompt`
  is manifest data because the current core evaluator interface expects
  synchronous prompt generation; async remote work belongs in `shouldRun`,
  `prepare`, and `process`.
- Response-handler evaluators can be declared with `name`, optional
  `description`, and optional `priority`. The local adapter registers them on
  the normal `plugin.responseHandlerEvaluators` field and proxies `shouldRun`
  and `evaluate` through JSON-safe context snapshots; returned patches must be
  JSON objects.
- Response-handler field evaluators can be declared with `name`, `description`,
  `schema`, optional `priority`, and optional `hasParse`/`hasHandle`. The local
  adapter registers them on the normal `plugin.responseHandlerFieldEvaluators`
  field, proxies JSON-safe `shouldRun`/`parse`/`handle` calls, and maps remote
  handle effects to JSON result patches, preempt directives, and debug traces.
- Lifecycle hooks can be declared with `lifecycle.hooks: ["init", "dispose", "applyConfig"]`.
  The local adapter exposes normal plugin `init`, `dispose`,
  and `applyConfig` hooks that proxy `plugin.lifecycle.call`; this keeps runtime
  registration, unload, reload, and hot config paths on the existing plugin
  lifecycle primitive. Static remote `config` is passed through the same normal
  plugin config conversion path used by local plugin initialization.
- `metadata`, when present, must be a JSON object.
- `bundlePath` and `bundleUrl`, when present, must be non-empty strings.
  `bundlePath` must be an asset path, optionally prefixed with `/`, without a
  URL scheme, query, hash, backslash, empty segment, `.` segment, or `..`
  segment.
  `bundleUrl` must be either an absolute `http` or `https` URL without
  embedded credentials or a same-origin absolute app/proxy path. Remote
  endpoints that provide `bundleUrl` directly are additionally constrained by
  the agent router to absolute `http` or `https` URLs without embedded
  credentials before any browser-facing manifest is exposed.

Relative remote `bundlePath` values are normalized by the agent-side router.
For unauthenticated development endpoints, the resulting `bundleUrl` can point
directly at the endpoint. For token-bearing endpoints, the resulting
`bundleUrl` is a same-origin agent proxy so browser dynamic imports never need
the stored endpoint bearer token:

```text
GET /api/capability-router/assets/:endpointId/:moduleId/<asset-path>
```

The agent proxy resolves the asset through the configured capability-router
service and injects the endpoint token server-side. Endpoint servers expose the
canonical provider asset URL:

```text
GET /v1/capabilities/assets/:moduleId/<asset-path>
```

The capability server resolves that request through `plugin.asset.get` and
returns the decoded asset bytes with the declared content type. The RPC result
is decoded before an HTTP response is built: returned asset paths must satisfy
the same safe asset-path rules as `bundlePath`, `contentType` and `integrity`
must not contain response-splitting control characters, and `bodyBase64` must
be valid standard base64. Local plugins should continue to use `bundlePath`.
The same-origin asset proxy is blocked for restricted mobile clients
(`X-Eliza-Platform: ios` or `android`) because App Store and Play Store style
builds cannot fetch and execute JavaScript that was not bundled at submission
time. Remote actions, providers, routes, and other RPC plugin surfaces remain
available through the capability-router protocol; dynamically imported remote
frontend bundles are desktop/web-only until a store-compliant packaged asset
story exists.

## Runtime Integration

The runtime path is:

```text
RemoteCapabilityRouterService
  -> plugin.modules.list
  -> createRemoteCapabilityPlugin(module)
  -> runtime.registerPlugin(plugin)
  -> existing lifecycle ownership / route dispatch / view registry
```

Remote actions, providers, evaluators, response-handler evaluators,
response-handler field evaluators, lifecycle hooks, events, models, services,
and routes are thin proxy contributions. They keep the runtime-local
registration shape, then call back through `getCapabilityRouter(runtime)` when
executed.

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
- Endpoint IDs must be non-empty and unique after trimming. Endpoint base URLs
  must be absolute `http` or `https` URLs, are normalized without query/hash or
  trailing slash, and must be unique. This prevents silent endpoint aliasing
  where two configured identities point at the same remote server.
- action/provider/route/model/asset calls are routed back to the endpoint that
  advertised the module. The aggregating router stamps each module with
  `capabilityEndpointId`, and the materialized plugin carries that endpoint id
  on every remote plugin RPC.
- Outbound remote route RPC calls validate callable HTTP methods, local absolute
  app paths, safe request headers, and safe query keys/values before crossing
  the capability boundary. Outbound remote asset RPC calls validate safe asset
  paths before dispatch.
- Outbound remote plugin RPC calls validate module ids and target identifiers
  such as action, provider, evaluator, event, model, service, lifecycle, and app
  bridge names before crossing the capability boundary. Service method calls use
  the same identifier and reserved-name rules as service manifests. Explicit
  endpoint ids on routed RPC calls are also validated before dispatch.
- Remote route and app-bridge route calls do not copy local or remote
  authorization, cookie, API-key, or auth-token headers across the boundary.
  Endpoint authentication stays in the capability-router transport layer instead
  of being copied from inbound user requests or remote route responses.
- Remote route RPC results must use integer HTTP status codes and valid HTTP
  response header names and values before they are exposed through local plugin
  route dispatch.
- low-level `fs`, `pty`, `git`, and `model.status` calls use the primary
  endpoint by default, or a specific endpoint when callers pass `endpointId`.

## Manifest Trust Policy

Remote manifests are not trusted just because they decode. The adapter accepts
an optional `trustPolicy` on `registerRemoteCapabilityPlugins`,
`syncRemoteCapabilityPlugins`, and `bootstrapRemoteCapabilityPlugins`:

- `allowedEndpointIds` rejects modules whose `capabilityEndpointId` is missing
  or not in the allowlist.
- `allowedModuleIds` rejects modules whose `module.id` is not in the allowlist.
- `requireEndpointId` rejects modules without endpoint provenance.

This gives product flows a concrete allow/deny boundary before remote modules
become normal runtime plugins. `syncRemoteCapabilityPlugins` and
`bootstrapRemoteCapabilityPlugins` return `trustDecisions` for accepted modules,
and trust-policy rejections include the rejected decision in the structured
`CapabilityError.details`. The policy is local to registration; stronger
attestation, signatures, and durable operator audit records still belong in the
provider/product layer.

Product connection flows use this policy by default. Direct endpoint connect
and cloud sandbox provisioning install one endpoint, then sync with
`allowedEndpointIds: [endpoint.id]` and `requireEndpointId: true`, so only
modules stamped by the installed endpoint can enter the runtime. Connect
requests may also provide `allowedModuleIds` to pin the exact remote modules
that are allowed to register from that endpoint; the CLI exposes this as
`elizaos capability-router connect --allowed-module <module-id...>`.
Endpoint-provider connects apply module allowlists before sync, so a shared
remote endpoint can expose multiple modules while the agent materializes only
the trusted subset and records non-allowlisted plugin names in `sync.skipped`.
The lower-level sync/register APIs remain strict and raise a structured trust
error when asked to register a non-allowlisted module directly.
Cloud connect requests accept module allowlists either at the top level or
inside the `cloud` object. Supplying both is rejected so a trust policy cannot
silently prefer one source over another.
When endpoint connection is persisted, the redacted local config also stores
module allowlists in `ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES` as a JSON object
keyed by endpoint id. On restart, `bootstrapRemoteCapabilityPlugins` derives a
trust policy from configured endpoint ids and these saved module allowlists, so
restart sync does not broaden trust beyond the original connected endpoint or
operator-selected modules.

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
This is now CI-enforced by
`bun run test:remote-capabilities:naming-audit`, which scans the current
capability-router source, architecture docs, app, core, shared, and workflow
roots. It only allows `satellite` in this historical naming analysis and in the
legacy `ELIZA_SATELLITE_RUNNER_*` compatibility alias path and precedence test.

## Critical Assessment Of PR #7779

Review target: <https://github.com/elizaOS/eliza/pull/7779>, inspected on
2026-05-19 with `gh pr view 7779 --repo elizaOS/eliza`. Refreshed on
2026-05-19 with `gh pr view 7779 --repo elizaOS/eliza --json
number,title,state,mergeable,headRefName,baseRefName,updatedAt,author,labels,url`.
The PR is open on `codex/phase-11-event-bridge-wip` against `develop`; GitHub
currently reports `mergeable: UNKNOWN`, last updated `2026-05-18T13:56:20Z`.

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

Concrete findings from the inspected PR files:

- `packages/agent/src/services/e2b-capability-router.ts` introduces a useful
  sandbox/provider adapter for E2B, Eliza Cloud, and home runners, but it is
  named around E2B/Satellite instead of the cross-runtime capability-router
  abstraction. It should be treated as one endpoint provider implementation, not
  as the agent's canonical dynamic plugin architecture.
- `packages/agent/docs/e2b-capability-routing.md` defines a Satellite HTTP
  contract with `/v1/health`, `/v1/fs/entries`, `/v1/fs/file`, and
  `/v1/processes/run`. That is a good coding-sandbox runner contract, but it is
  not sufficient for dynamic plugins because it has no `plugin.modules.list`,
  no remote action/provider/evaluator/service/app manifest, no route registry,
  and no frontend asset contract.
- `packages/cloud-services/coding-satellite/src/index.ts` is appropriately
  workspace-scoped for filesystem and process execution, including bearer auth
  and path guards, but it exposes only low-level runner capabilities. A coding
  container built from this shape still needs a capability-router plugin server
  layer before the agent can treat its output like a normal plugin.
- `packages/app-core/platforms/electrobun/docs/capability-routing.md` makes the
  right responsibility split for desktop: plugins mean things, satellites
  execute system operations, and UI renders. The limitation is platform scope:
  the objective also requires iOS, cloud-to-home, home-to-cloud, and generic
  coding-agent-created modules. The canonical abstraction must live in core and
  agent packages, with Electrobun satellites as one deployment backend.
- GitHub currently reports `mergeable: UNKNOWN`, so mergeability and any
  validation list in the PR body should be treated as historical until re-run on
  the current head.

Current branch provider-adapter check:

- The historical PR files above are not present in this checkout. A current
  file scan under `packages/agent`, `packages/cloud-services`, `packages/app-core`,
  `plugins`, and `.github` finds the canonical implementation in
  `remote-capability-router`, `remote-plugin-adapter`, the agent API route, and
  the Cloud provisioner only.
- `packages/agent/src/services/remote-capability-cloud-sandbox.ts` is the only
  concrete provider adapter currently wired to the canonical endpoint model. It
  normalizes Cloud create/provision/job responses into a
  `RemoteCapabilityEndpointConfig`, installs that endpoint into
  `RemoteCapabilityRouterService`, and syncs modules through the same remote
  plugin adapter and endpoint/module trust policy used by direct endpoints.
- There is no current E2B, home-machine, mobile-companion, or coding-satellite
  provider implementation to fold in. Those should be added as thin endpoint
  providers that return the same endpoint config and serve the same
  `plugin.modules.list`, `plugin.*`, route, and asset RPC contract, not as new
  runtime abstractions or separate remote-plugin contracts.

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
- Canonical protocol fixture
  `CAPABILITY_ROUTER_PROTOCOL_FIXTURE` in `packages/core/src/capabilities`,
  covering availability, manifest, action, provider, route, model, lifecycle,
  event, service, app bridge, and asset payloads with the broad plugin surfaces
  expected from a dynamic remote plugin, including structural component type
  definitions, plugin contexts, and top-level plugin priority.
- Plugin surface audit in
  `packages/scripts/audit-capability-router-plugin-surface.ts`, exposed as
  `bun run test:remote-capabilities:surface-audit`, which fails when a new
  local `Plugin` field is not classified as remote-supported or intentionally
  local-only for capability-router.
- Capability-router naming audit in
  `packages/scripts/audit-capability-router-naming.ts`, exposed as
  `bun run test:remote-capabilities:naming-audit`, which fails if the canonical
  source/docs/workflow roots reintroduce `satellite` as runtime abstraction
  vocabulary outside this architecture record's historical naming analysis and
  the legacy env-alias compatibility path.
- Runnable reference endpoint in
  `packages/scripts/capability-router-fixture-server.ts`, exposed as
  `bun run capability-router:fixture-server`, that serves the canonical fixture
  through the same `/v1/capabilities` and `/v1/capabilities/invoke` HTTP
  protocol expected from real remote endpoints. The endpoint can also serve a
  built view bundle from disk, which lets the fixture-server smoke prove the
  build-output path instead of only replaying an embedded static asset.
- Core exports from node, browser, and edge entrypoints.
- Agent HTTP client/server bridge in
  `packages/agent/src/services/remote-capability-router.ts`.
- Agent cloud sandbox endpoint provisioner in
  `packages/agent/src/services/remote-capability-cloud-sandbox.ts`.
- Shared endpoint-provider adapter contract in
  `packages/agent/src/services/remote-capability-endpoint-provider.ts`, so
  direct endpoints, Cloud, E2B, home-machine runners, mobile companions, and
  future providers all converge to the same `RemoteCapabilityEndpointConfig`
  plus endpoint/module trust policy before plugin sync.
- Reusable endpoint conformance harness in
  `packages/agent/src/services/remote-capability-endpoint-conformance.ts` that
  connects to any configured endpoint through the normal
  `RemoteCapabilityRouterService`, verifies availability and manifest shape,
  and exercises action, provider, evaluator, response-handler evaluator,
  response-handler field evaluator, route, model, lifecycle, event, service,
  app bridge, and compiled view asset RPC surfaces.
- URL-backed endpoint providers in
  `packages/agent/src/services/remote-capability-url-endpoint-providers.ts`
  for concrete E2B, home-machine, mobile-companion, and desktop-companion
  endpoints. These providers normalize and validate provider URLs before the
  generic endpoint-provider adapter installs the router and syncs plugins.
- Agent API route `POST /api/capability-router/connect` that installs an
  already-provisioned endpoint or provisions a Cloud endpoint, then syncs remote
  plugins without returning stored tokens. Direct endpoint connect and
  URL-backed provider modes (`e2b`, `home-machine`, `mobile-companion`, and
  `desktop-companion`) use the same endpoint-provider adapter path as Cloud
  provisioning, so product connect flows converge before runtime service
  installation and plugin sync.
- Restart persistence for connected endpoints: redacted endpoint metadata is
  saved in `eliza.json`, while token-bearing `ELIZA_CAPABILITY_ROUTER_URLS`
  lives in the existing `config.env` secret channel and is re-applied to
  `process.env` on startup.
- Persisted endpoint module allowlists through
  `ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES`, with bootstrap deriving endpoint
  and module trust policy from saved configuration after restart.
- `elizaos capability-router connect` CLI command for calling that agent API
  against direct endpoints, URL-backed provider families, or Cloud provisioning
  flows.
- `elizaos capability-router conformance <baseUrl>` CLI command for validating
  an arbitrary endpoint against the transport-level plugin protocol without
  provider-specific code.
- Remote manifest to `Plugin` adapter in
  `packages/agent/src/services/remote-plugin-adapter.ts`.
- Startup sync in `packages/agent/src/runtime/eliza.ts`.
- Remote `bundleUrl` support in the view registry.
- Multi-endpoint plugin aggregation and endpoint-specific invocation routing.
- Materialized remote plugins preserve endpoint affinity with
  `capabilityEndpointId`, so multiple remote devices or cloud containers can
  contribute modules without later calls falling back to the primary endpoint.
- Incremental endpoint-provider connects preserve already-installed runtime
  endpoints. The sync path fetches only the newly connected endpoint's manifest
  and scopes `unloadMissing` to plugins owned by that endpoint, so connecting a
  second device or sandbox does not unload the first device's remote plugins.
- Explicit `endpointId` routing for low-level `fs`, `pty`, `git`, and
  `model.status` capabilities.

Current focused tests cover:

- core method validation and error decoding,
- canonical protocol fixture decoder validation through
  `RuntimeBrokerCapabilityRouter`,
- HTTP request/response round trips,
- fetch-handler server contract,
- remote module manifests,
- action/provider/evaluator/response-handler evaluator/response-handler field
  evaluator/lifecycle/event/model/service/route proxying,
- remote widget declarations on the normal `plugin.widgets` field,
- remote static config on the normal `plugin.config` field,
- remote database schema declarations on the normal `plugin.schema` field,
- remote entity component type declarations on the normal
  `plugin.componentTypes` field,
- remote plugin context declarations on the normal `plugin.contexts` field,
- remote top-level plugin priority on the normal `plugin.priority` field,
- remote app metadata and nav tabs on the normal `plugin.app` field,
- remote route path and app nav path validation before runtime route/nav
  metadata is exposed,
- remote app viewer and launch URL validation before browser-facing app
  metadata is exposed,
- remote service method validation before unique methods are synthesized on a
  local service prototype,
- remote JSON-safe app bridge hooks through a runtime route-module registry,
- skip/reload/unload sync behavior, including removal of stale remote
  actions, providers, routes, plugin records, and view-registry entries when a
  module disappears from an endpoint manifest,
- multiple remote endpoints,
- endpoint affinity on materialized plugin config and action/provider/route/model RPC
  payloads,
- remote component ownership checks that reject action/provider/evaluator and
  response-handler name reuse by a different already-registered remote module,
- remote model ownership checks that reject duplicate model types across
  modules, against already-registered remote modules, and against local runtime
  model handlers,
- low-level capability routing to explicit endpoint ids,
- generic endpoint-provider adapters that provision or resolve an endpoint,
  install the normal `RemoteCapabilityRouterService`, and sync plugins through
  the same endpoint/module trust policy regardless of whether the provider is
  direct, Cloud, E2B, home-machine, or mobile-companion,
- API connect routing for direct endpoints through the generic `direct`
  endpoint provider rather than a separate install/sync branch,
- API connect routing for URL-backed `e2b`, `home-machine`,
  `mobile-companion`, and `desktop-companion` providers through the exported
  provider implementations, so product clients can select provider families
  without reintroducing satellite-specific runtime code,
- sequential provider connects preserving multiple live endpoints and keeping
  action RPC affinity for plugins from both endpoints,
- provider-family conformance for E2B, home-machine, and mobile-companion
  adapters using the exported URL-backed provider implementations: each
  resolves to the same endpoint-provider contract and exposes action, provider,
  evaluator, response-handler evaluator, response-handler field evaluator,
  route, model, lifecycle, event, service, app bridge, view manifest, and asset
  RPC surfaces through the normal remote plugin adapter,
- reusable endpoint conformance for arbitrary capability-router URLs: the
  harness validates plugin availability, nonempty/unique module manifests, and
  end-to-end action, provider, evaluator, response-handler evaluator,
  response-handler field evaluator, route, model, lifecycle, event, service,
  app bridge, and view-asset RPC execution without depending on
  provider-specific code,
- URL-backed provider validation for E2B/home/mobile endpoint URLs, rejecting
  non-HTTP schemes, embedded URL credentials, and unsafe endpoint ids before
  runtime service installation,
- product route sequential direct-connect flow preserving multiple live
  endpoints through `/api/capability-router/connect`, with both endpoint-owned
  plugins remaining invokable after the second connect,
- product route mixed direct-plus-Cloud connect flow preserving a local device
  endpoint and a Cloud-provisioned endpoint in the same running router, with
  both endpoint-owned plugins remaining invokable and Cloud endpoint tokens
  redacted from the API response,
- cloud sandbox provisioning normalization from Cloud create/provision/job
  responses into capability-router endpoint configs,
- cloud sandbox connection helper that installs the returned endpoint into the
  runtime capability-router service and syncs remote modules through normal
  plugin ownership, including mocked Cloud action, provider, evaluator,
  response-handler evaluator, response-handler field evaluator, route, model,
  lifecycle, event, service, app bridge, and compiled view asset calls through
  the provisioned endpoint with bearer auth,
- authenticated agent route for direct endpoint connection or Cloud
  provisioning, including token redaction in API responses,
- remote route and app-bridge route header sanitization so local user/agent
  secrets are not forwarded to remote capability endpoints, and remote route
  responses cannot set sensitive headers back onto the agent origin,
- same-origin remote asset proxy for token-bearing endpoint bundles, so browser
  dynamic imports do not receive or need bearer tokens,
- endpoint persistence that preserves restart reload without serializing
  endpoint tokens into `eliza.json`,
- restart hydration through the real `config.env` secret channel: after
  `loadElizaConfig()` repopulates `process.env`, bootstrap registers the router
  service, syncs remote modules, and sends the persisted bearer token on
  `plugin.modules.list`,
- product-route restart hydration: a persisted
  `/api/capability-router/connect` direct endpoint survives a simulated
  restart, reloads through `config.env`, preserves the endpoint/module trust
  allowlist, and sends the bearer token from the secret channel during
  bootstrap,
- CLI payload construction for direct endpoint and Cloud provisioning flows,
- CLI payload construction for URL-backed provider-family connects using the
  same `provider` discriminator accepted by `/api/capability-router/connect`,
- CLI endpoint conformance checks for arbitrary capability-router URLs,
  including bearer auth, action/provider/evaluator/response-handler
  evaluator/response-handler field evaluator/route/model/lifecycle/event/service
  /app bridge/view-asset exercise, route status and non-empty body validation, and
  required-surface validation,
- duplicate module ID rejection,
- real localhost HTTP capability-server integration,
- no-credential source-build smoke: a temporary remote plugin source tree builds
  a browser bundle, serves a manifest with action/provider/evaluator/response-
  handler evaluator/response-handler field evaluator/route/model/lifecycle/
  event/service/app-bridge/assets over the capability protocol, then bootstraps
  into the runtime without local plugin registration code
  (`bun run test:remote-capabilities:source-build`),
- no-credential process-isolation smoke: a built remote plugin runs from a
  separate child-process capability server and is consumed through HTTP only,
- Docker/container smoke: two built remote plugin modules are packaged into one
  real Docker container, exposed as one capability server, trusted by explicit
  endpoint/module allowlist, and consumed through the same runtime path
  (`bun run test:remote-capabilities:docker`),
- remote route dispatch through the actual API route dispatcher,
- remote route RPC response validation before status/header metadata is exposed
  through local route dispatch,
- outbound remote route and asset RPC request validation before endpoint
  dispatch,
- outbound remote plugin RPC target validation before endpoint dispatch,
- remote `STATIC` route rejection until a dedicated remote static mount
  contract exists,
- remote frontend bundle URL normalization,
- remote frontend asset path validation before browser import URL creation and
  before same-origin asset proxy dispatch,
- remote frontend bundle URL validation before browser import URL exposure,
- remote view id collision rejection before frontend entries are handed to the
  local view registry,
- remote widget id collision rejection before widget declarations are handed to
  the UI widget resolver,
- remote app nav tab id collision rejection before shell navigation metadata is
  exposed,
- remote app bridge route-key collision rejection against both sync-batch
  modules and existing runtime app route modules before app route modules are
  registered,
- remote asset RPC response validation before decoded bytes and content-type
  metadata are exposed through the asset proxy,
- restricted-platform guard on the same-origin remote asset proxy, so iOS and
  Android clients cannot bypass the existing dynamic frontend bundle policy via
  `/api/capability-router/assets/...`,
- browser-facing view registry and `/api/views` metadata for remote absolute
  bundle URLs,
- app-shell `DynamicViewLoader` behavior for absolute remote bundle URLs,
  including direct bundle import and remote view `interact` handler
  registration,
- focused Playwright app-shell smoke that starts a real remote
  capability-style HTTP endpoint, derives `/api/views` metadata from
  `plugin.modules.list`, and imports the view bundle from that endpoint
  (`bun run test:remote-capabilities:ui`).
- focused Playwright product-flow smokes that use Settings -> Capabilities to
  submit both a direct endpoint and an Eliza Cloud provisioning payload to
  `/api/capability-router/connect`; the direct endpoint smoke receives synced
  module metadata and opens the remote view through normal app navigation
  (`bun run test:remote-capabilities:ui`).

Run the no-credential CI slice with:

```text
bun run test:remote-capabilities
```

Run the focused source-build/process-boundary smoke with:

```text
bun run test:remote-capabilities:source-build
```

Run the container-backed CI smoke with Docker available:

```text
bun run test:remote-capabilities:docker
```

Run the credentialed cloud sandbox live smoke with an Eliza Cloud API key:

```text
ELIZAOS_CLOUD_API_KEY=... bun run test:remote-capabilities:cloud-live
```

The GitHub `Tests` workflow now runs `bun run test:remote-capabilities`,
`bun run test:remote-capabilities:surface-audit`,
`bun run test:remote-capabilities:naming-audit`,
`bun run test:remote-capabilities:source-build`,
`bun run test:remote-capabilities:fixture-server`, and
`bun run test:remote-capabilities:validate-live-reports:self-test`, and
`bun run test:remote-capabilities:docker` in the server job for pull requests
and pushes. The validator self-test generates complete and partial live report
fixtures so the artifact validator is itself covered without external
credentials. The source-build smoke builds a temporary remote plugin source tree
and consumes it only through the capability protocol, then repeats the same
runtime path across a child-process endpoint. The fixture-server smoke builds a
temporary remote view bundle, starts the runnable reference endpoint with that
bundle, validates it with the CLI conformance path, and imports the returned
asset as JavaScript.
The Docker smoke builds two remote frontend bundles, builds and runs one
containerized capability server that advertises two plugin modules, syncs both
through the normal remote plugin adapter with endpoint/module trust policy,
imports both compiled bundles, and executes each module's remote
action/provider/evaluator/response-handler evaluator/response-handler field
evaluator/route/model/lifecycle/event/service/app-bridge handlers through the
protocol.
The same workflow also runs `bun run test:remote-capabilities:cloud-live` in
the credentialed cloud-live job. On `workflow_dispatch` and nightly schedules,
the job now fails during preflight when the Cloud API key is missing, so an
observed live run cannot silently become a green skip. That live smoke provisions a real
Eliza Cloud capability endpoint, verifies it exposes at least one remote plugin
module with a compiled view bundle through the reusable endpoint conformance
harness, syncs it through the same endpoint trust policy, and executes remote
action/provider/evaluator/response-handler evaluator/response-handler field
evaluator/route/model/lifecycle/event/service/app-bridge/view-asset surfaces
through the canonical protocol.
When observed, the job uploads `remote-capability-cloud-live-report`, a JSON
artifact from `reports/remote-capabilities/cloud/*.json` containing the
endpoint id, observed module ids, and every exercised full-surface RPC target.
CI clears and recreates that report directory immediately before the live smoke,
so validation and upload only see files produced by the current run.
Before upload, CI runs
`bun run test:remote-capabilities:validate-live-reports
reports/remote-capabilities/cloud` so a malformed or partial live observation
cannot become the recorded evidence for Cloud completion. The validator also
requires `schemaVersion: 1`, `--kind cloud` or `--kind provider`,
`--expect-count 1` for Cloud, `--expect-count 3..4` for provider reports,
`--max-age-minutes 90`, `--max-future-minutes 5`, `--require-ci`, and
`--require-file-identity`, and `--match-github-env` in CI, requires the
report-level endpoint id to match the conformance endpoint id, requires
`cloud.json` for Cloud and `<provider>.json` for provider reports, and rejects
stale or future-dated observations, missing malformed, or mismatched GitHub run
metadata, duplicate endpoint ids, duplicate provider reports, malformed endpoint
ids, non-lowercase provider names, missing or mismatched provider IDs, invalid
Cloud API base URLs, Cloud API base URLs with query or fragment components,
cloud artifacts with provider-only fields, provider artifacts with cloud-only fields,
non-2xx route results, route results without a non-empty observable body payload,
non-JavaScript view asset paths/content types, missing, malformed, or
empty-content view asset SHA-256 digests, missing model results, failed
lifecycle calls, unhandled event calls, asset integrity values that do not match
the recorded asset digest, empty action/provider/evaluator/response handler
outputs, missing service/app-bridge results, and credential-shaped field
names or string values such as tokens,
authorization headers, API keys, passwords, secrets, bearer/basic auth values,
and URLs with embedded credentials anywhere in the artifact. Every exercised RPC
target must also start with one of the module ids observed in the live manifest,
and that same module id must also appear in the trusted registered module set.
Every registered module id must be exercised by at least one conformance RPC
target recorded in `conformance.moduleExercises`. The conformance harness keeps
the required surface summary in `conformance.exercised`, then performs
additional cheap RPC calls for untouched modules so multi-module endpoints still
produce per-module exercise evidence without overwriting the summary target.
The harness fails at observation time when action, provider, evaluator,
response-handler evaluator, response-handler field evaluator, service, or app
bridge calls return empty success-shaped payloads, and when lifecycle or event
calls do not report success.
When a view asset includes subresource integrity metadata, the harness verifies
that value against the fetched bundle bytes before recording the observation.
The live report writer rejects unknown report kinds before writing, only accepts
lowercase hyphenated report names, enforces `cloud.json` for Cloud and
`<provider>.json` for provider reports, requires provider report `providerId`
to match `provider`, rejects provider-only fields on Cloud artifacts and
cloud-only fields on provider artifacts, and writes with exclusive create so a
second artifact cannot overwrite the first observation.
`sync.registered` and `sync.registeredModules` must not contain duplicate
materialized plugin/module identities, and every registered module must have a
unique trusted `sync.trustDecisions` entry, so full-surface evidence is tied
back to unique endpoint modules that actually materialized locally. Individual
modules may be partial plugins; the validator requires each registered module to
materialize at least one remote plugin surface and requires the aggregate
registered module counts to cover every required surface, including remote event
handlers through `eventCount` and remote app metadata through `appCount`.
`sync.skipped` and `sync.unloaded` must be unique plugin-name lists and cannot
contradict `sync.registered` or each other. The report is written only after
remote modules sync into the runtime and includes
registered plugin names, registered plugin-to-module-to-endpoint identities,
per-registered-module surface counts, trust decisions, and runtime counts for
plugins, actions, providers, evaluators, response-handler evaluators,
response-handler field evaluators, routes, models, services, app bridges,
lifecycle hooks, widgets, component types, and views. In GitHub Actions it also
includes workflow/run id, run attempt, event name, repository, ref, and commit
SHA. The validator requires the trusted module decisions to match registered
runtime plugin identities, requires every registered remote module to have
positive counts for each required surface, and requires the runtime counts to
prove the registered plugin count and remote surfaces materialized locally, not
only that RPC calls succeeded.
When the workflow event is not `workflow_dispatch` or `schedule`, the job writes
an explicit notice and step summary saying the remote capability cloud smoke was
not observed for that run.
The workflow also has an optional provider-live job for URL-backed E2B,
home-machine, mobile-companion, and desktop-companion endpoints. It runs
`bun run --cwd packages/agent test:remote-capabilities:provider-live` on
manual/nightly workflows. The preflight allows a full no-secret skip only for
non-observed workflow events; on manual/nightly runs it fails before setup when
all provider endpoint secrets are absent or when any required E2B, home-machine,
or mobile-companion URL secret is missing. Each configured provider must expose
at least one remote action, provider, route, JSON model handler, lifecycle hook,
event handler, service method, app bridge hook, evaluator, response-handler
evaluator, response-handler field evaluator, and view through the
capability-router protocol. Provider CI validation uses
`--allowed-providers e2b,home-machine,mobile-companion,desktop-companion` and
`--require-providers e2b,home-machine,mobile-companion` with
`--expect-count 3..4`, so the live artifact is not accepted as provider evidence
unless every provider report belongs to the known provider-family vocabulary,
those three concrete provider families were observed, and only the optional
desktop-companion report may appear beyond the required set.
When observed, the job uploads `remote-capability-provider-live-report`, with
one JSON file per configured provider under
`reports/remote-capabilities/providers/*.json`. CI clears and recreates that
report directory immediately before the provider live smoke, so validation and
upload only see files produced by the current run. CI validates those reports with
`bun run test:remote-capabilities:validate-live-reports
reports/remote-capabilities/providers` before upload, requiring every full
remote plugin surface to be present in each configured provider observation,
requiring E2B/home/mobile provider reports, and rejecting inconsistent endpoint
ids, malformed provider labels, leaked credential-shaped fields, or exercised
targets that do not belong to an observed module. Provider reports also include
the provider ID returned by the endpoint provider, the sync summary, registered
remote module identities, and runtime materialization counts from the agent that
connected to the endpoint.
If provider endpoint secrets exist but the workflow event is not
`workflow_dispatch` or `schedule`, the job writes an explicit notice and step
summary saying the provider live smoke was not observed for that run.
The non-secret Cloud provisioner test mirrors that contract with a mocked Cloud
endpoint by syncing a module that contributes an action, provider, route, JSON
model handler, lifecycle hook, event handler, service method, app bridge hook,
evaluator, response-handler evaluator, response-handler field evaluator, and
compiled view asset through the installed capability-router service.

Run the browser app-shell remote view smoke:

```text
bun run test:remote-capabilities:ui
```

Validate any running endpoint directly from the CLI:

```text
elizaos capability-router conformance https://remote.example.test --token ...
```

Run the local reference endpoint and validate it with the same CLI:

```text
bun run capability-router:fixture-server --token fixture-token
elizaos capability-router conformance http://127.0.0.1:<port> --token fixture-token
```

Current local verification ledger:

- `bunx vitest run packages/agent/src/api/remote-capability-routes.test.ts
--coverage.enabled=false` passed with 19 tests passing after adding the
  restricted-platform capability asset proxy guard and product-route provider
  selection for URL-backed endpoint providers.
- `bunx vitest run
packages/app-core/src/cli/program/register.capability-router.test.ts
--coverage.enabled=false` passed with 6 tests passing for direct,
  URL-backed provider, Cloud, invalid-provider CLI payload construction, and
  direct endpoint conformance validation.
- `bunx tsc --noEmit -p packages/app-core/tsconfig.json --pretty false`
  passed after adding the CLI conformance command.
- `bunx tsc --noEmit -p packages/ui/tsconfig.json --pretty false` passed after
  adding the Settings provider-family selector.
- `bunx vitest run
packages/agent/src/services/remote-capability-endpoint-provider.test.ts
--coverage.enabled=false` passed with 6 tests passing after switching
  E2B/home/mobile conformance to the exported URL-backed provider
  implementations.
- `bunx vitest run
packages/agent/src/services/remote-capability-endpoint-conformance.test.ts
--coverage.enabled=false` passed with 2 tests passing for a conforming
  endpoint and a missing required plugin surface.
- `bunx vitest run packages/core/src/capabilities/index.test.ts
--coverage.enabled=false` passed with 48 tests passing after adding the
  canonical capability-router protocol fixture, remote component type/context
  decoding, top-level remote priority, and decoder-validity test.
- `bun run test:remote-capabilities:surface-audit` passed, confirming all 28
  local `Plugin` fields are either remote-supported or intentionally local-only
  for the capability-router protocol.
- `bun run test:remote-capabilities:naming-audit` passed, confirming the
  audited source/docs/workflow roots do not use `satellite` as canonical runtime
  abstraction vocabulary; the only allowed hits are this architecture record's
  historical naming analysis, the legacy `ELIZA_SATELLITE_RUNNER_*` aliases,
  and the precedence test that proves canonical env names win.
- `bun run capability-router:fixture-server --token fixture-token` started the
  runnable reference endpoint on localhost, and
  the local app-core CLI entrypoint
  `capability-router conformance <fixture-url> --token fixture-token` passed
  against it, exercising the canonical fixture through HTTP.
- `bun run test:remote-capabilities:fixture-server` passed, automatically
  building a temporary remote view bundle, starting the reference endpoint,
  running CLI conformance against it with bearer auth, importing the returned
  bundle as JavaScript, and tearing it down.
- `bun run --cwd packages/agent test:remote-capabilities` passed with 188
  tests passing and 3 skipped. The canonical suite covers registered-remote
  component ownership checks, cross-module/local model collision checks, stale
  contribution cleanup coverage for disappearing remote modules, runtime app
  route-module collision protection for remote app bridges, and live report
  writer safety for report names, identity, duplicate artifacts, and weak
  conformance result rejection.
- `bun run --cwd packages/agent test:remote-capabilities:source-build` passed
  with 2 focused tests passing and 35 adapter tests skipped by name filter.
- `bun run --cwd packages/agent test:remote-capabilities:provider-live` found
  the provider smoke file and skipped 4 provider tests locally because no
  `ELIZA_REMOTE_CAPABILITY_*_URL` endpoints are configured.
- `bun run test:remote-capabilities:validate-live-reports <dir>` passed against
  generated complete Cloud/provider report samples and rejected a generated
  partial provider report that lacked required full-surface RPC evidence.
- `bun run test:remote-capabilities:validate-live-reports:self-test` passed and
  is part of the normal no-credential server CI gate, so the live report
  validator is tested even when live endpoint secrets are absent. The self-test
  covers complete reports, wrong-schema reports, missing-surface reports,
  endpoint-id mismatches, malformed endpoint ids, malformed provider labels,
  invalid Cloud API base URLs, Cloud API base URLs with query or fragment
  components, provider report filename/provider mismatches, failed route
  responses, non-JavaScript view assets, missing or malformed view asset SHA-256
  digests, wrong artifact report counts, stale, future-dated, or malformed
  observations, Cloud/provider reports with valid CI metadata, Cloud/provider
  GitHub-env match and mismatch checks, missing, malformed, mismatched, or
  non-observed-event CI run metadata, missing required GitHub environment variables under
  `--match-github-env`, duplicate artifact endpoint/provider identities,
  missing, malformed, or duplicate provider endpoint URL fingerprints, accidental
  credential-shaped fields and string values, valid required-only and
  required-plus-desktop provider report sets, unknown provider-family reports,
  missing required provider-family observations, malformed remote module ids,
  exercised RPC targets without `moduleId:target` syntax,
  exercised RPC targets that reference unobserved module ids, exercised RPC
  targets from manifest-only modules that did not register locally, registered
  modules that were never exercised by conformance RPC, duplicate
  manifest module ids, duplicate materialized plugin/module registration
  identities, duplicate trust decisions, sync trust decisions for unobserved
  modules, and reports that claim a plugin was both registered and
  skipped/unloaded or both skipped and unloaded,
  trusted modules that did not register as runtime plugins, zero
  per-registered-module surface counts, and missing
  evaluator/service/response-handler materialization.
- `bun run --cwd packages/agent test:remote-capabilities:docker` passed with
  the single real Docker container smoke passing and 36 adapter tests skipped
  by name filter. The command now runs only the container-backed smoke.
- `bun run --cwd packages/app test:remote-capabilities:ui` passed with 3
  Playwright tests passing; the Settings endpoint-connect smoke selects
  `home-machine` and asserts the `/api/capability-router/connect` payload
  includes that provider discriminator.
- `bunx tsc --noEmit -p packages/core/tsconfig.json --pretty false` passed
  after the canonical protocol fixture update.
- `bun run --cwd packages/agent build:dist` passed and emitted
  `dist/services/remote-capability-endpoint-provider.js` plus declarations,
  proving the shared endpoint-provider contract is included in the package
  build.
- `bun run --cwd packages/agent build:mobile` passed after repairing the local
  `packages/node_modules/three` symlink; `dist-mobile/agent-bundle.js` contains
  `RemoteCapabilityRouterService`, `bootstrapRemoteCapabilityPlugins`,
  `remote-capability-endpoint-provider`, `/api/capability-router/connect`, and
  the restricted-platform asset proxy guard.
- `bun run --cwd packages/agent build:ios-jsc` passed;
  `dist-mobile-ios-jsc/agent-bundle-ios.js` contains the same
  capability-router service, bootstrap sync, endpoint-provider contract,
  connect route, and restricted-platform asset proxy guard. The build warned
  that the JSContext polyfill prefix was not present locally and must be
  prepended at install time, which is existing mobile build behavior.
- `bunx vitest run
packages/agent/src/services/remote-capability-cloud-sandbox.test.ts
packages/agent/src/services/remote-capability-cloud-sandbox.cloud-smoke.test.ts
--coverage.enabled=false` passed with 5 tests passing and 1 skipped after
  moving Cloud live validation onto the reusable endpoint conformance harness.
- `bun run test:remote-capabilities:live-ci-audit` passes and statically
  enforces that the workflow keeps the Cloud and provider live jobs wired to
  strict scheduled/manual observation, and that the final `test-status` gate
  treats scheduled runs as strict, with required provider endpoints, strict
  live report validation, required artifact upload, and matching live report
  directories between smoke producers, validators, and uploaded artifacts. It
  also audits the package-level `test:remote-capabilities` script so live report
  writer safety remains in the canonical remote-capability suite, audits the
  provider live smoke source so provider reports keep recording `providerId`,
  audits the live report writer so runtime remote plugin entries keep
  per-module surface counts, audits the live report validator so those runtime
  counts keep matching `sync.registeredModules`, audits the endpoint
  conformance harness and live report validator so route evidence keeps
  requiring non-empty JSON body payloads, and audits endpoint conformance so
  view assets keep being fetched as non-empty bytes with SHA-256 evidence and
  integrity checks against those bytes, and audits the live report validator so
  uploaded artifacts keep rejecting non-JavaScript, manifest-mismatched,
  missing-digest, empty-digest, malformed-digest, and integrity-mismatched view
  asset evidence. It also audits the validator self-test source so route-body
  and asset failure fixtures and assertions stay present,
  requires the live report validator self-test to stay in CI, and audits the
  root package scripts that invoke the live report validator, the validator
  self-test, the live CI audit, and the live CI audit self-test.
- `bun run test:remote-capabilities:live-ci-audit:self-test` mutates those
  report-directory env vars, artifact upload paths, provider live report
  `providerId` evidence, runtime remote plugin per-module count evidence, route
  body evidence in both source conformance and report validation, view asset
  byte/digest/integrity evidence in endpoint conformance and live report
  validation, validator self-test route-body and asset fixture coverage, root
  package live validator and live CI audit
  script wiring, package-level remote capability suite membership, final
  `test-status` live job gating,
  scheduled/manual live observation gates, Cloud
  freshness/identity validation flags, provider primary endpoint secret
  enforcement, provider allowed/required lists, and provider GitHub-env
  matching, and proves the live-CI audit fails when smoke output no longer
  feeds the validator/artifact path or when the Cloud/E2B/home/mobile
  observation contract is weakened.
- Provider live reports include `endpointUrlSha256`, a SHA-256 fingerprint of
  the normalized endpoint base URL. The live report validator requires this
  fingerprint for provider artifacts and rejects duplicates across the provider
  report set, so E2B/home/mobile evidence cannot silently come from the same
  configured transport URL. The fingerprint helper also strips query/fragment
  components and rejects embedded URL credentials before hashing, matching the
  URL-backed endpoint provider's accepted base URL shape.
- Provider live reports also include `providerId` from the endpoint provider,
  and the validator requires it to match the report provider label, so a live
  artifact cannot be relabeled across E2B, home-machine, mobile-companion, or
  desktop-companion provider families.
- Live report writers only accept lowercase report names with numbers or
  hyphens, require Cloud reports to be named `cloud`, require provider reports
  to be named after their provider, require provider IDs to match provider
  labels, and create report files with exclusive writes, so a duplicate Cloud or
  provider report cannot silently overwrite an earlier artifact before
  validation/upload.
- Conformance reports include an `rpcCalls` ledger that records every canonical
  protocol method used for each exercised surface and module. The live report
  validator requires this ledger to cover every `moduleExercises` entry, every
  summarized required surface, and every evaluator phase (`shouldRun`,
  `prepare`, `prompt`, `process`, response-handler `evaluate`, and field
  `parse`/`handle`), so live evidence proves the endpoint was exercised through
  the standard RPC-like protocol, not only materialized in a manifest.
- Model, lifecycle, event, service, and app-bridge conformance results must
  carry their required protocol success fields: `modelResult.result`,
  `lifecycleResult.ok: true`, `eventResult.handled: true`,
  `serviceResult.result`, and `appBridgeResult.result`.
- View-asset conformance now preserves manifest-declared asset metadata and
  rejects fetched bundles whose content type or integrity value contradicts the
  manifest, whose integrity value does not include a SHA-256 token, or whose
  integrity value does not match the fetched bytes. The live CI audit now also
  statically protects the source-side byte fetch, non-empty byte check,
  SHA-256 digest recording, and integrity-to-byte comparison. The live report
  validator also rejects artifacts whose recorded manifest asset metadata
  disagrees with the fetched asset metadata, whose integrity value lacks or does
  not match the recorded SHA-256 digest, or whose fetched JavaScript bundle
  digest is the empty SHA-256 digest; the live CI audit now statically protects
  those artifact-side validator rules as well.
- Runtime live summaries include `runtime.remotePlugins`, keyed by plugin name,
  endpoint id, module id, and per-module surface counts. The validator requires
  this runtime identity list and each module's runtime surface counts to match
  `sync.registeredModules` exactly, so aggregate count totals cannot stand in
  for proof that the synced remote modules actually reached the runtime with the
  expected actions, providers, routes, views, app bridges, lifecycle hooks, and
  other plugin surfaces, and stale remote modules did not remain loaded.
- Provider allowlist skips now emit rejected trust decisions (`trusted: false`,
  `reason: "module-not-allowed"`) with endpoint, module, and plugin identity.
  The live report validator requires every `sync.skipped` entry to have a
  rejected trust decision, so skipped modules are auditable rather than just
  unexplained plugin names.
- `bun run test:remote-capabilities:surface-audit` also audits the canonical
  plugin RPC method union. Every `plugin.*` method must be implemented by the
  fixture server, and every non-list plugin RPC method must appear in endpoint
  conformance plus the live report validator's required-method matrix. The
  audit also rejects validator-required plugin methods that are not canonical
  non-list RPC methods, and verifies endpoint conformance surfaces, validator
  required surfaces, and validator method-matrix keys stay in exact agreement.
  This keeps protocol expansion from bypassing the full-surface proof path.
- Endpoint conformance reports type `rpcCalls.method` from the core
  `RuntimeBrokerCapabilityMethod` plugin-method union, excluding only
  `plugin.modules.list`, so conformance evidence cannot drift to ad-hoc method
  names while the validator and surface audit enforce coverage.
- `bun run --cwd packages/agent test:remote-capabilities:cloud-live` skipped
  locally because no `ELIZAOS_CLOUD_API_KEY` is configured. A real Cloud run
  remains a required live-provider observation before claiming the Cloud side
  complete.

## Requirement Matrix

| Requirement                                                | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Status                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Canonical abstraction is not `satellite`                   | Core/API/CLI/docs use `capability-router`; `bun run test:remote-capabilities:naming-audit` CI-enforces that `satellite` only appears in this architecture record's historical naming analysis, the legacy env-alias compatibility path, and its precedence test within audited runtime/docs/workflow roots.                                                                                                                                                                      | Implemented                                                                                                     |
| Dynamic remote plugins materialize as normal local plugins | Adapter maps remote manifests into runtime `Plugin` objects with actions, providers, routes, lifecycle, events, models, services, config, schema, component types, contexts, priority, widgets, app metadata, app bridge hooks, and views. A CI surface audit classifies every local `Plugin` field.                                                                                                                                                                              | Implemented                                                                                                     |
| Runs across machines/processes/containers                  | Local HTTP, child-process, and Docker capability servers are consumed through the same protocol; Docker smoke is a CI gate.                                                                                                                                                                                                                                                                                                                                                       | Implemented for local/container isolation                                                                       |
| Mobile bundle reachability                                 | Android and iOS JSC mobile agent bundles include the capability-router service, bootstrap plugin sync, endpoint-provider contract, and connect route; remote frontend asset proxy is blocked for restricted mobile platforms.                                                                                                                                                                                                                                                     | Implemented for protocol reachability; dynamic frontend bundles intentionally restricted on app-store platforms |
| Agent product flow can connect remote capability endpoints | API, CLI, and Settings UI connect direct endpoints, URL-backed E2B/home/mobile/desktop-companion providers, and Cloud provisioning payloads.                                                                                                                                                                                                                                                                                                                                      | Implemented with focused smokes                                                                                 |
| Frontend bundles load from remote plugins                  | View registry metadata, same-origin asset proxy for token-bearing bundles, app-shell loader tests, and Playwright UI smoke cover compiled remote bundles on web/desktop. The same proxy is blocked for iOS/Android clients to respect dynamic-code-loading policy.                                                                                                                                                                                                                | Implemented for web/desktop; restricted on app-store mobile                                                     |
| Endpoint and module trust is explicit                      | Connect flows use endpoint allowlists, optional module allowlists, duplicate/colliding identities are rejected, and restart bootstrap derives trust from persisted endpoint/module config.                                                                                                                                                                                                                                                                                        | Implemented                                                                                                     |
| Real CI exercises the path                                 | Server CI runs focused remote-capability tests and Docker smoke; UI smoke runs compiled remote bundle and Settings connect flows; a live-CI audit statically enforces that Cloud and URL-backed provider smokes stay wired to scheduled/manual observation, strict live report validation, required provider endpoints, required artifact upload, and matching report directories from smoke output through validation/upload. Provider live report validation also requires unique redacted endpoint URL fingerprints across provider artifacts. | Implemented, live provider observations pending                                                                 |
| Real Cloud sandbox provider                                | Live smoke provisions an Eliza Cloud endpoint, verifies manifest/view asset, syncs modules, and executes action/provider/evaluator/response-handler evaluator/response-handler field evaluator/route/model/lifecycle/event/service/app-bridge when `ELIZAOS_CLOUD_API_KEY` is present.                                                                                                                                                                                            | Implemented but must be observed green                                                                          |
| E2B/home-machine/mobile provider coverage                  | Exported URL-backed providers normalize and validate concrete E2B, home-machine, mobile-companion, and desktop-companion endpoints; focused conformance exercises E2B/home/mobile through action/provider/evaluator/response-handler evaluator/response-handler field evaluator/route/model/lifecycle/event/service/app-bridge/view/asset RPC; optional scheduled/manual provider-live CI smokes use the reusable endpoint conformance harness against configured real endpoints. | Implemented for URL-backed provider layer; live endpoint observations pending                                   |

## Implementation Plan

The target architecture should converge in this order:

1. Core protocol parity.
   Keep adding runtime-consumed `Plugin` surfaces to the remote manifest only
   when the local runtime already has a real registration or execution path for
   that surface. The current remote surface covers actions, providers,
   evaluators, response-handler evaluators, response-handler field evaluators,
   lifecycle hooks, events, models, services, routes, component types, contexts,
   widgets, app metadata, app bridge hooks, config, schema, and compiled views.
   New remote manifest fields should still wait for a concrete local runtime
   registration or execution path before they are added to the protocol.
2. Endpoint-provider adapters.
   Treat E2B, Eliza Cloud, home-machine runners, mobile companion processes,
   and Electrobun desktop companions as endpoint providers. Each provider can expose
   low-level `fs`/`pty`/`git` primitives and may also run a plugin-module server
   that speaks `GET /v1/capabilities`, `POST /v1/capabilities/invoke`, and
   asset fetches. Provider-specific runner contracts must not leak into the
   remote plugin manifest.
3. Product connection flows.
   Keep direct endpoint connection, Cloud provisioning, restart persistence,
   token redaction, and Settings UI connection on the same endpoint model.
   Product flows should return endpoint metadata, then call the normal sync path
   so remote modules enter the existing runtime lifecycle.
4. Isolation and auth.
   Require bearer auth for endpoint invocation and asset fetches outside local
   dev. Keep workspace path guards, symlink-write rejection, output/read limits,
   and command timeouts at the provider layer. Add explicit endpoint identity and
   module identity checks before treating remote manifests as trusted runtime
   contributions.
5. Verification.
   Keep no-credential CI focused on protocol, runtime registration, process
   isolation, built frontend bundles, product direct-connect flow, and a real
   Docker container capability server. Keep the credentialed Eliza Cloud
   capability sandbox smoke in nightly/manual CI, and add E2B/home-machine
   live smokes once those providers are stable enough to avoid flaky default CI.

## Remaining Work Before This Is "Done"

This is not complete until the following are true:

- A real isolated sandbox provider can build a plugin from source, serve its
  manifest and compiled frontend bundle, and expose action/provider/route/model
  plus evaluator/response-handler evaluator/response-handler field evaluator/
  lifecycle/event/service/app-bridge handlers through the capability-router
  protocol. The no-credential local
  source-build and child-process smokes prove the protocol and process-boundary
  paths; the Docker smoke is now a server CI gate that proves local container
  isolation, multiple modules in one sandbox, explicit endpoint/module trust
  policy, and broad runtime-surface execution for each module.
- The agent can create or connect to that sandbox from normal product flows.
  The agent-side provisioner, API route, and CLI can now connect/sync returned
  endpoints into a runtime with verified restart persistence through
  `config.env`; the product Settings UI now exposes and smoke-tests direct
  endpoint connection and Cloud provisioning payload construction. Direct
  product-route restart hydration is covered; Cloud provision, persist, restart,
  and reopen-view E2E remains pending.
- Auth is specified and enforced for endpoint registration, invocation, and
  frontend asset access.
- Endpoint identity, module identity, route namespace, view registry identity,
  action/provider/evaluator, response-handler evaluator, service type, app
  bridge route key, and model type collision rules are enforced in the local
  adapter/router, including collisions against already-registered remote modules
  and local runtime handlers. The adapter also accepts an explicit trust policy for
  endpoint/module allowlists before registration. Remaining trust work is
  attestation and operator audit records for those decisions.
- Remote view loading is covered through the browser-facing view registry
  metadata path, real compiled bundle fetch/evaluation smokes, app-shell loader
  unit coverage, and a focused Playwright app-shell smoke against a running
  remote capability-style server. The Settings connect flow is now covered for
  direct endpoints and Cloud provisioning payloads; a fuller E2E that provisions
  through Cloud, persists, restarts, and reopens the remote view is still needed.
- CI runs focused remote-capability tests plus a Docker-backed container smoke
  without external credentials.
- Credentialed nightly/manual CI runs a real Eliza Cloud capability sandbox
  smoke when `ELIZAOS_CLOUD_API_KEY` is configured. This must be observed green
  against the live provider before claiming the cloud side of the goal complete;
  E2B/home-machine provider smokes are still pending.
- The old satellite-specific names are either removed from canonical APIs or
  kept only as compatibility aliases.
