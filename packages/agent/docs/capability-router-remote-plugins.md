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
  adapter-owned remote plugin.
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
- Lifecycle hooks can be declared with `lifecycle.hooks: ["init", "dispose",
  "applyConfig"]`. The local adapter exposes normal plugin `init`, `dispose`,
  and `applyConfig` hooks that proxy `plugin.lifecycle.call`; this keeps runtime
  registration, unload, reload, and hot config paths on the existing plugin
  lifecycle primitive. Static remote `config` is passed through the same normal
  plugin config conversion path used by local plugin initialization.
- `metadata`, when present, must be a JSON object.
- `bundlePath` and `bundleUrl`, when present, must be non-empty strings.

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
- action/provider/route/asset calls are routed back to the endpoint that
  advertised the module. The aggregating router stamps each module with
  `capabilityEndpointId`, and the materialized plugin carries that endpoint id
  on every remote plugin RPC.
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

## Critical Assessment Of PR #7779

Review target: <https://github.com/elizaOS/eliza/pull/7779>, inspected on
2026-05-19 with `gh pr view 7779 --repo elizaOS/eliza`. The PR is open on
`codex/phase-11-event-bridge-wip` against `develop`; GitHub currently reports
`mergeable: CONFLICTING`.

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
- The PR body says GitHub reports the branch as mergeable, but the current PR
  metadata reports `CONFLICTING`. Treat any validation list in the PR body as
  historical until re-run on the current head.

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
- Persisted endpoint module allowlists through
  `ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES`, with bootstrap deriving endpoint
  and module trust policy from saved configuration after restart.
- `elizaos capability-router connect` CLI command for calling that agent API
  against direct endpoints or Cloud provisioning flows.
- Remote manifest to `Plugin` adapter in
  `packages/agent/src/services/remote-plugin-adapter.ts`.
- Startup sync in `packages/agent/src/runtime/eliza.ts`.
- Remote `bundleUrl` support in the view registry.
- Multi-endpoint plugin aggregation and endpoint-specific invocation routing.
- Materialized remote plugins preserve endpoint affinity with
  `capabilityEndpointId`, so multiple remote devices or cloud containers can
  contribute modules without later calls falling back to the primary endpoint.
- Explicit `endpointId` routing for low-level `fs`, `pty`, `git`, and
  `model.status` capabilities.

Current focused tests cover:

- core method validation and error decoding,
- HTTP request/response round trips,
- fetch-handler server contract,
- remote module manifests,
- action/provider/evaluator/response-handler evaluator/response-handler field
  evaluator/lifecycle/event/model/service/route proxying,
- remote widget declarations on the normal `plugin.widgets` field,
- remote static config on the normal `plugin.config` field,
- remote database schema declarations on the normal `plugin.schema` field,
- remote app metadata and nav tabs on the normal `plugin.app` field,
- remote JSON-safe app bridge hooks through a runtime route-module registry,
- skip/reload/unload sync behavior,
- multiple remote endpoints,
- endpoint affinity on materialized plugin config and action/provider/route RPC
  payloads,
- low-level capability routing to explicit endpoint ids,
- cloud sandbox provisioning normalization from Cloud create/provision/job
  responses into capability-router endpoint configs,
- cloud sandbox connection helper that installs the returned endpoint into the
  runtime capability-router service and syncs remote modules through normal
  plugin ownership,
- authenticated agent route for direct endpoint connection or Cloud
  provisioning, including token redaction in API responses,
- same-origin remote asset proxy for token-bearing endpoint bundles, so browser
  dynamic imports do not receive or need bearer tokens,
- endpoint persistence that preserves restart reload without serializing
  endpoint tokens into `eliza.json`,
- restart hydration through the real `config.env` secret channel: after
  `loadElizaConfig()` repopulates `process.env`, bootstrap registers the router
  service, syncs remote modules, and sends the persisted bearer token on
  `plugin.modules.list`,
- CLI payload construction for direct endpoint and Cloud provisioning flows,
- duplicate module ID rejection,
- real localhost HTTP capability-server integration,
- no-credential source-build smoke: a temporary remote plugin source tree builds
  a browser bundle, serves a manifest/action/provider/route/assets over the
  capability protocol, then bootstraps into the runtime without local plugin
  registration code,
- no-credential process-isolation smoke: a built remote plugin runs from a
  separate child-process capability server and is consumed through HTTP only,
- Docker/container smoke: two built remote plugin modules are packaged into one
  real Docker container, exposed as one capability server, trusted by explicit
  endpoint/module allowlist, and consumed through the same runtime path
  (`bun run test:remote-capabilities:docker`),
- remote route dispatch through the actual API route dispatcher,
- remote frontend bundle URL normalization,
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

Run the container-backed CI smoke with Docker available:

```text
bun run test:remote-capabilities:docker
```

Run the credentialed cloud sandbox live smoke with an Eliza Cloud API key:

```text
ELIZAOS_CLOUD_API_KEY=... bun run test:remote-capabilities:cloud-live
```

The GitHub `Tests` workflow now runs both `bun run test:remote-capabilities`
and `bun run test:remote-capabilities:docker` in the server job for pull
requests and pushes. The Docker smoke builds two remote frontend bundles, builds
and runs one containerized capability server that advertises two plugin modules,
syncs both through the normal remote plugin adapter with endpoint/module trust
policy, imports both compiled bundles, and executes each module's remote
action/provider/route handlers through the protocol.
The same workflow also runs `bun run test:remote-capabilities:cloud-live` in
the credentialed cloud-live job on `workflow_dispatch` and nightly schedules
when `ELIZAOS_CLOUD_API_KEY` is configured. That live smoke provisions a real
Eliza Cloud capability endpoint, verifies it exposes at least one remote plugin
module with a compiled view bundle, syncs it through the same endpoint trust
policy, and executes remote action/provider/route surfaces.

Run the browser app-shell remote view smoke:

```text
bun run test:remote-capabilities:ui
```

## Requirement Matrix

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Canonical abstraction is not `satellite` | Core/API/CLI/docs use `capability-router`; satellite remains compatibility/provider vocabulary only. | Implemented |
| Dynamic remote plugins materialize as normal local plugins | Adapter maps remote manifests into runtime `Plugin` objects with actions, providers, routes, lifecycle, events, models, services, config, schema, widgets, app metadata, app bridge hooks, and views. | Implemented |
| Runs across machines/processes/containers | Local HTTP, child-process, and Docker capability servers are consumed through the same protocol; Docker smoke is a CI gate. | Implemented for local/container isolation |
| Agent product flow can connect remote capability endpoints | API, CLI, and Settings UI connect direct endpoints; API/CLI/Settings support Cloud provisioning payloads. | Implemented with focused smokes |
| Frontend bundles load from remote plugins | View registry metadata, same-origin asset proxy for token-bearing bundles, app-shell loader tests, and Playwright UI smoke cover compiled remote bundles. | Implemented |
| Endpoint and module trust is explicit | Connect flows use endpoint allowlists, optional module allowlists, duplicate/colliding identities are rejected, and restart bootstrap derives trust from persisted endpoint/module config. | Implemented |
| Real CI exercises the path | Server CI runs focused remote-capability tests and Docker smoke; UI smoke is available through `bun run test:remote-capabilities:ui`; live Cloud smoke is scheduled/manual with secret. | Implemented, live Cloud observation pending |
| Real Cloud sandbox provider | Live smoke provisions an Eliza Cloud endpoint, verifies manifest/view asset, syncs modules, and executes action/provider/route when `ELIZAOS_CLOUD_API_KEY` is present. | Implemented but must be observed green |
| E2B/home-machine/mobile provider coverage | Architecture treats these as endpoint providers behind the protocol; provider-specific live smokes are not yet present. | Pending |

## Implementation Plan

The target architecture should converge in this order:

1. Core protocol parity.
   Keep adding runtime-consumed `Plugin` surfaces to the remote manifest only
   when the local runtime already has a real registration or execution path for
   that surface. The current remote surface covers actions, providers,
   evaluators, response-handler evaluators, response-handler field evaluators,
   lifecycle hooks, events, models, services, routes, widgets, app metadata, app
   bridge hooks, config, schema, and compiled views. `componentTypes` remains
   intentionally out of scope until the runtime has a concrete registration path
   for it.
2. Endpoint-provider adapters.
   Treat E2B, Eliza Cloud, home-machine runners, mobile companion processes,
   and Electrobun satellites as endpoint providers. Each provider can expose
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
  manifest and compiled frontend bundle, and expose action/provider/route
  handlers through the capability-router protocol. The no-credential local
  source-build and child-process smokes prove the protocol and process-boundary
  paths; the Docker smoke is now a server CI gate that proves local container
  isolation, multiple modules in one sandbox, and explicit endpoint/module trust
  policy.
- The agent can create or connect to that sandbox from normal product flows.
  The agent-side provisioner, API route, and CLI can now connect/sync returned
  endpoints into a runtime with verified restart persistence through
  `config.env`; the product Settings UI now exposes and smoke-tests direct
  endpoint connection and Cloud provisioning payload construction.
  Restart-through-product-flow E2E remains.
- Auth is specified and enforced for endpoint registration, invocation, and
  frontend asset access.
- Endpoint identity, module identity, route namespace, action/provider/evaluator,
  response-handler evaluator, service type, and per-module model declaration
  collision rules are enforced in the local adapter/router. The adapter also
  accepts an explicit trust policy for endpoint/module allowlists before
  registration. Remaining trust work is attestation and operator audit records
  for those decisions.
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
