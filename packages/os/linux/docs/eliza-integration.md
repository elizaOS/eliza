# Eliza Integration

This doc explains where usbeliza touches the elizaOS framework and where it
diverges, and **why** each divergence exists. The short answer: usbeliza is
the **minimal-mode** Eliza host — it runs from a stateless squashfs in
tmpfs, has no database, no vault, no Discord/Telegram channel surface, and
serves a single chat box. Many of the things that make `bootElizaRuntime`
useful for the milady desktop app are dead weight (or impossible) in that
context.

This is not larp. usbeliza uses the same primitives every other Eliza host
uses — `AgentRuntime`, `Plugin`, `Action`, `Memory`, `IAgentRuntime`,
`ModelType`, `CharacterSchema`. What we customize, milady also customizes;
we just customize differently because the deployment context is different.

---

## What we use from upstream (verbatim)

| Primitive | Source | How we use it |
|---|---|---|
| `AgentRuntime` | `@elizaos/core` | Direct construction in `agent/src/runtime/eliza.ts` (vs. milady's `bootElizaRuntime` wrapper — see § Why not `bootElizaRuntime`). |
| `Character` / `CharacterSchema` | `@elizaos/agent/config/character-schema` | Validates `agent/src/characters/eliza.ts` at module load. Same Zod schema milady uses. |
| `Plugin`, `Action`, `Memory`, `IAgentRuntime`, `State` | `@elizaos/core` | Every action exports a real `Action`; every plugin exposes a real `Plugin`. No custom wrappers. |
| `ModelType.TEXT_LARGE` / `TEXT_SMALL` | `@elizaos/core` | Our `localLlamaPlugin` and `claudeCloudPlugin` register handlers under these keys. `runtime.useModel(ModelType.TEXT_LARGE, …)` routes through them via core's priority resolver. |
| `stringToUuid` | `@elizaos/core` | Stable agent + entity + room IDs across squashfs rebuilds. |
| Action `similes` ranking | `@elizaos/core` shape, our `match.ts` implementation | We rank Eliza-shaped Actions deterministically without the LLM-planning step — see § Why not `processActions`. |
| `PROVIDER_PLUGIN_MAP` | `eliza/packages/agent/src/runtime/plugin-collector.ts:136` (synced inline — see § Why we inline) | Env-var → plugin auto-load. `ANTHROPIC_API_KEY` exported → `@elizaos/plugin-anthropic` registered at boot. |

---

## What we deliberately don't use (and why)

### Why not `bootElizaRuntime()` from `@elizaos/agent`

The canonical bootstrap is a ~600-line function at
`packages/agent/src/runtime/eliza.ts:2697 → startEliza()`. It does, in order:

1. Resolve + register baseline `@elizaos/plugin-*` modules
2. Capture early logs into a chat-mirror buffer
3. Migrate legacy `~/.milady` → `~/.eliza` state directory
4. Load `~/.eliza/eliza.json` config
5. Run interactive first-time CLI setup (skipped in headless mode)
6. Apply Discord / Telegram / Slack channel secrets to `process.env`
7. Auto-resolve Discord app ID
8. Apply ElizaCloud config to `process.env`
9. Apply x402 micropayments config to `process.env`
10. Apply database config to `process.env`
11. Run vault bootstrap (separate PGLite worker, OS-keychain hydration)
12. Migrate wallet keys from secure store
13. **Register `@elizaos/plugin-sql` (PGLite, ~50MB) — mandatory**
14. Plus ~30 more init steps for the full milady surface

usbeliza's deployment context makes most of this impossible or wasted:

- **No vault, no wallet, no `x402` payments**, no Discord/Telegram/Slack.
  None of that has a place on a USB ISO that boots from squashfs.
- **No PGLite by default.** Locked decision #19: persistence is opt-in via
  LUKS — the agent runs from a stateless tmpfs and writes nothing to disk
  unless the user unlocks a persistent partition. Forcing PGLite would add
  ~50 MB to the squashfs and a write-loop the live ISO doesn't need.
- **No `~/.eliza/eliza.json` interactive onboarding** — the agent boots
  into the chat UI, and onboarding happens through that chat box. No
  prompt-on-CLI, ever.
- **No interactive readline loop.** We serve HTTP on 127.0.0.1:41337 to
  the chat UI (`elizad`); we never enter the canonical CLI loop.

So we instantiate `AgentRuntime` directly with our three plugins and call
`runtime.initialize({ skipMigrations: true, allowNoDatabase: true })`.
This is a public API of `@elizaos/core`. We're not bypassing the framework
— we're using a different entry point of it. Milady wraps
`bootElizaRuntime` heavily anyway (warmup, dimension cap, post-boot repair
at `app-core/src/runtime/eliza.ts:813`); there's no "pure canonical
adoption" even in the reference app.

**Migration path** (once LUKS persistence ships, locked decision #19):

When the user unlocks a persistence partition we'll register
`@elizaos/plugin-sql` with a PGLite path under
`/home/eliza/.eliza/db/`, then re-route boot through `bootElizaRuntime`
for the persistent session. The minimal-mode path stays for the
non-persistent live-USB case.

### Why not `startApiServer()` from `@elizaos/agent`

Same constraint: `startApiServer()` expects a PGLite-backed agent, the
vault for auth bootstrap, a Hono app with milady's `/api/auth`, `/api/cloud`,
`/api/secrets`, `/api/workbench` route surface — none of which exist on a
USB ISO that just needs `POST /api/chat` and a few WebSocket upgrades for
the wifi / OAuth flows.

We use `Bun.serve` in `agent/src/main.ts` with the same `{ schema_version,
reply, launch, actionName }` JSON shape the elizad client expects. That's
the contract; we don't need a Hono compatibility layer to honor it.

**Migration path**: alongside the LUKS-PGLite migration we'll evaluate
adopting `startApiServer` with a Linux-specific route module. If our
custom Bun.serve is still simpler at that point we'll keep it and
document the gap; if it's costing us in plugin-registered route
discovery we'll switch.

### Why not `runtime.processActions()`

The canonical Eliza dispatch composes state, calls
`runtime.useModel(TEXT_LARGE)` to ask the LLM to pick an action, then
calls the chosen action's handler. That's the right shape for a
free-form conversational agent where most messages are chat and only
some trigger an action.

On a USB OS where the chat box IS the desktop, **most messages are
intents** ("open clock", "what time is it", "connect to wifi", "make my
wallpaper red"). Routing every one of those through a 30-second CPU-bound
LLM planning step would make the desktop feel broken. So
`agent/src/runtime/dispatch.ts` does deterministic ranking on
`Action.similes` (the same data `processActions` reads), picks the best
match, and calls `action.handler(runtime, message, …)` directly. The LLM
fallback only fires when no action matches — that's when we want chat.

This trades framework completeness for user-perceived latency. The
trade-off is documented in `dispatch.ts:7-14` so future readers don't
think it's an oversight.

**Migration path**: open. If a future Eliza release adds a
"deterministic-similes mode" to `processActions` we'd switch over. The
current rank function is small (~60 lines) and the Action shapes are
upstream-compatible.

### Why we wrap `node-llama-cpp` directly (`local-llama-plugin.ts`)

There IS a `@elizaos/plugin-local-inference` shipping at beta.2, but:

1. It has a **hard `@elizaos/plugin-capacitor-bridge` import** at
   `local-inference-routes.ts:18-21` — unconditional, not lazy.
   capacitor-bridge is the iOS/Android mobile bridge; pulling it into a
   desktop Linux ISO doesn't make sense.

2. **Milady itself doesn't consume it** for local inference. milady has
   its own `app-core/src/services/local-inference/device-bridge.ts`
   (different shape, different deps). The canonical Eliza pattern for
   embedded local-inference is to write your own Plugin that exposes
   `models[ModelType.TEXT_LARGE]` — exactly what we do.

Our `local-llama-plugin.ts` is 154 lines, no transitive mobile deps,
exposes the same `Plugin.models[ModelType.TEXT_*]` shape the upstream
plugin uses, and gets called the same way (`runtime.useModel`). The
runtime can't tell the difference. If `@elizaos/plugin-local-inference`
ever splits its core provider from the mobile/HTTP bridge into a
desktop-installable package, we'd swap to it — until then our
implementation matches milady's own pattern.

**Missing features compared to upstream**: dflash speculative decoding,
Vulkan GPU acceleration, KV-cache spill, hardware-probe-based model
selection. Future work could either upstream a node-llama-cpp variant of
plugin-local-inference, or wire those features into our own plugin. For
now the 1B model on CPU is fast enough for the USB context.

### Why we wrap `claude` CLI (`claude-cloud-plugin.ts`)

`@elizaos/plugin-anthropic` exists and uses the Anthropic SDK. Adopting
it would require `ANTHROPIC_API_KEY` — a raw API key the user has to mint
on console.anthropic.com.

The usbeliza target user has **Claude Code**, not raw API access. Claude
Code authenticates via an OAuth subscription flow (`claude auth login`)
and that auth is bound to the `claude` CLI binary; the user's Claude Code
subscription is metered against the binary, not against an API key.
Shelling out to `claude --print` reuses that auth — the user doesn't have
to manage two credentials.

When the user happens to have `ANTHROPIC_API_KEY` set, our env-var
auto-loader (see § plugin-collector adoption) will register
`@elizaos/plugin-anthropic` on top of `claude-cloud-plugin`. Both can
coexist; the priority resolver picks whichever has the higher priority
(claude-cloud is pinned at 100).

### Why we inline `PROVIDER_PLUGIN_MAP`

`@elizaos/agent`'s public-API export of `PROVIDER_PLUGIN_MAP` is the
right primitive to use. But the moment you `import * from "@elizaos/agent"`
you also pull in its transitive module graph —
`@elizaos/plugin-browser-bridge`, `@elizaos/app-training`, the SQL/vault
boot chain, and more. Those packages exist in the elizaOS monorepo
workspace but not in our agent's `node_modules` (we ship a minimal
dep tree).

So we inline the 20-entry constant map at the top of `eliza.ts` with a
comment explicitly marking it as **synced from upstream**, including the
file path and commit hash to resync against. If Eliza adds a new model
provider tomorrow (e.g. `LLAMACLOUD_API_KEY`), the resync is a one-line
addition. That's cheaper than carrying the transitive deps just to read
one constant.

---

## Plugin-collector adoption (live)

`agent/src/runtime/eliza.ts → autoLoadProviderPlugins()` runs after
`runtime.initialize()` and iterates `PROVIDER_PLUGIN_MAP`. For each
env-var that's set in `process.env`, it dynamic-imports the corresponding
`@elizaos/plugin-*` and calls `runtime.registerPlugin(plugin)`.

Behavior in different environments:

| Env var | Plugin | When it loads |
|---|---|---|
| `ANTHROPIC_API_KEY` | `@elizaos/plugin-anthropic` | User exports their key; plugin-anthropic is installed (e.g. via `bun add` on a dev box). |
| `OPENAI_API_KEY` | `@elizaos/plugin-openai` | Same. |
| `OLLAMA_BASE_URL` | `@elizaos/plugin-ollama` | User runs a local ollama daemon and points us at it. |
| (17 other entries) | various | Per the inlined map. |

Failures are soft: if the package isn't installed (`Cannot find module`)
or the plugin's register throws, we log to stderr and continue. The agent
boots without the optional plugin. This matches milady's behavior in
`collectPluginNames` where missing plugins are logged but not fatal.

**Bundle impact**: zero, by design. We don't add any plugin-* package to
our `dependencies` array. Users opt into bigger surfaces by installing
the packages themselves (and setting the env var). On the live USB the
chroot hook bakes in only the packages we actually ship.

---

## Recap: what would the "fully canonical" path look like

If someone wanted usbeliza to look identical to milady's runtime, the
work is:

1. **Add LUKS persistence to the live ISO** (decision #19, pending) so we
   have a place to put a PGLite database.
2. **Add `@elizaos/plugin-sql`** as a dependency. ~50 MB to the squashfs
   size budget — needs to be measured against the rest of the ISO.
3. **Generate `~/.eliza/eliza.json`** on first boot with defaults
   suitable for USB (no Discord/Telegram channels enabled, vault
   passphrase derived from a USB-bound secret).
4. **Replace `new AgentRuntime(...)` with `bootElizaRuntime({...})`** —
   one-line change in `eliza.ts`, but transitively pulls in (a) (b) (c).
5. **Replace `Bun.serve` with `startApiServer()`** and add a usbeliza
   route module for the chat / wifi / OAuth / build / open endpoints.
6. **Adopt `runtime.processActions()`** for chat-fallthrough and
   re-evaluate the per-turn LLM cost.

This is multi-day, multi-PR work and adds real complexity. The
minimal-mode path documented above is the explicit alternative we've
chosen for the live-USB context. Both paths can coexist (minimal for the
non-persistent live boot, full for the post-LUKS-unlock session) once
(1)-(2) ship.

---

## Re-sync cadence

When upstream changes — particularly the items below — this doc and the
inlined `PROVIDER_PLUGIN_MAP` need a refresh:

- **New model provider added** to
  `eliza/packages/agent/src/runtime/plugin-collector.ts` — add the env
  var + package name to our inlined map.
- **`bootElizaRuntime` signature changes** in
  `eliza/packages/agent/src/runtime/eliza.ts:2697` — re-read it, update
  the "Why not `bootElizaRuntime`" section if the rationale shifts.
- **`@elizaos/plugin-local-inference` splits the capacitor dep** out of
  its core provider — that's the trigger for adopting it in place of
  our `local-llama-plugin.ts`.

Last resync against eliza/develop @ commit `93d3afcbea` on 2026-05-13.
