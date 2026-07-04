# elizaOS — repository guide for agents

This is the **elizaOS** monorepo: an open-source framework for building and
deploying autonomous AI agents, plus the runtime, CLI, dashboard, cloud
backend, native bridges, and first-party plugins built on top of it. The repo
is **self-contained** — everything needed to run, test, and ship an Eliza agent
lives here.

`CLAUDE.md` and `AGENTS.md` in every directory are **identical** — author
`CLAUDE.md`, then copy it to `AGENTS.md`. Read the package-local `CLAUDE.md`
before working inside any package or plugin; this root file is the map.

## Naming

Write **elizaOS** (not `ElizaOS`). npm scope is `@elizaos/*`. In plain language,
say **Eliza agents**. Exception: the **Eliza Classic** plugin keeps `Eliza`
(the 1966 chatbot it reimplements).

## Toolchain

- **Runtime:** [Bun](https://bun.sh) (`packageManager` is pinned in
  `package.json`) on **Node 24** (`engines.node`). ESM only (`"type": "module"`).
- **Monorepo:** [Turbo](https://turbo.build) drives `build` / `typecheck` /
  `lint` / `test` across workspaces. Workspace globs are in `package.json`
  (`packages/*`, `plugins/*`, `packages/native/*`, `packages/os/*`,
  `packages/examples/*`, `packages/cloud/services/*`, …).
- **Lint/format:** [Biome](https://biomejs.dev) (`biome.json`). Ignore globs in
  `.biomeignore`.
- **Tests:** Vitest, orchestrated by `packages/scripts/run-all-tests.mjs`.
- **TypeScript:** project-references build; root `tsconfig.json`,
  `tsconfig.base.json`, per-package `tsconfig.json`.

## Root commands

```bash
bun install            # workspace install (runs postinstall: submodules, patches)
bun run install:light  # install without downloading the large artifact bundle
bun run dev            # boot the API + dashboard UI (packages/app-core dev-ui)
bun run build          # turbo build across the workspace
bun run verify         # typecheck + lint (alias: bun run check) — run before "done"
bun run lint           # biome lint via turbo
bun run format         # biome format via turbo
bun run typecheck      # tsc across workspace (8 GB heap)
bun run test           # full suite (run-all-tests.mjs)
bun run test:server    # core/agent/app-core/shared/vault/elizaos/skills/scenario-runner
bun run test:client    # app/ui + lifeops/training plugins
bun run test:e2e       # end-to-end lane
bun run start          # run an agent (packages/agent start)
bun run clean          # nuke dist/.turbo/node_modules, reinstall, rebuild
bun run cloud:mock     # boot the full local cloud stack with mocks
```

Scope any command to one package with `--cwd`:
`bun run --cwd packages/core test`. The repo has ~200 root scripts; the list
above is the day-to-day set. Use `bun run` with no args to print them all.

## Repo map — where to find what

```
packages/        framework, shared libraries, and product surfaces
  core/          @elizaos/core — runtime, types, agent loop, memory/state, model layer
  agent/         @elizaos/agent — AgentRuntime, plugin loader, default plugin map
  app-core/      API + dashboard host; dev/build orchestration (dev-ui.mjs)
  elizaos/       the `elizaos` CLI — create / info / upgrade / version; project + plugin templates
  prompts/       shared prompt scaffolding
  shared/        cross-package utilities + brand assets
  ui/            shared React component library
  app/           web + desktop dashboard (Vite + React; desktop shell)
  tui/           terminal UI
  skills/        runtime skills knowledge base (USE_SKILL)
  scenario-runner/ scenario + eval harness
  cloud/api/     managed backend API (Hono on Cloudflare Workers)
  app/           web + desktop dashboard; also hosts the current cloud apex UI
  cloud/shared/  shared cloud backend: db (Drizzle), billing, services, types
  cloud/sdk/ cloud/routing/ cloud/infra/  cloud client SDK, model routing, IaC
  contracts/     on-chain contracts + ABIs
  security/ vault/ soc2-verify/  secrets, key management, compliance tooling
  os/ robot/                     device/OS images, OS landing, robotics
  plugin-remote-manifest/ plugin-worker-runtime/
                 remote plugin manifests, host shims, and worker runtime support
  homepage/ docs/ docs-elizacloud-redirect/  marketing site, docs site, redirects
  examples/      30+ standalone runnable examples (each has its own README)
  benchmarks/    30+ evaluation suites (each has its own README + harness)

plugins/         runtime plugins and app plugins
  plugin-<model>/      openai, anthropic, google-genai, groq, openrouter, xai, ollama, …
  plugin-<connector>/  discord, telegram, farcaster, slack, imessage, whatsapp, x, …
  plugin-native-*/     native device bridges (camera, contacts, calendar, location, …)
  plugin-local-inference/  on-device llama.cpp (Kokoro TTS folded in) / whisper (git submodules under native/)
  plugin-sql/ plugin-localdb/ plugin-inmemorydb/  storage adapters
  plugin-documents/ plugin-lifeops/ plugin-health/ …  app plugins

scripts/         repo automation        patches/   dependency patches
skills/          runtime skill packages turbo.json knip.json  build + dead-code config
```

Every package and plugin carries its own `CLAUDE.md` / `AGENTS.md` (identical)
and `README.md`. **Read the package-local doc first** — it lists that package's
layout, exports, scripts, env vars, and gotchas.

## Runtime architecture in 60 seconds

- **`@elizaos/core`** is the framework: the agent loop, the plugin model, and
  the message / memory / state primitives, with a model-agnostic LLM layer.
  If your code depends on `@elizaos/core`, you are using the framework.
- **`@elizaos/agent`** wires a runnable agent: `AgentRuntime`, the plugin
  loader, and the default plugin map.
- A **plugin** is `src/index.ts` exporting a `Plugin` object that registers:
  - **actions** — things the agent can *do* (validate + handler),
  - **providers** — context injected into the prompt,
  - **services** — long-lived singletons (clients, schedulers, connectors),
  - **evaluators** — post-response processing,
  - plus routes, events, and model handlers.
- **`@elizaos/app-core`** hosts the HTTP API + dashboard that runs agents.
- The **`elizaos` CLI** is intentionally minimal: scaffolding (`create`),
  info, and template upgrades. Project/plugin scaffolds live in
  `packages/elizaos/templates/` (`min-project`, `min-plugin` have `SCAFFOLD.md`
  contracts).

To build on the runtime from your own TypeScript with no CLI/UI, import
`@elizaos/core` directly — see `packages/examples/` (30+ standalone references).

## Repo-wide conventions

- **Logger only, never `console`** in server code. Use the structured logger,
  prefix messages with `[ClassName]`, attach context objects on errors.
- **ESM only.** No CommonJS.
- **No business computation in proxy/route layers.** Derive values in
  use-cases and return DTO fields the client just renders. Clients display,
  never compute.
- **DTO fields are required by default;** don't paper over a broken pipeline
  with `?? 0` or `as` casts.
- Keep weak types (`any` / `unknown` / unsafe casts) out; validate at runtime
  boundaries and type the validated result.

## Error-Handling Simplification

Binding policy for all error handling (parent #12182, foundation #12263). The
codebase is full of defensive sludge — empty catches, log-and-continue that
fabricates a result, `return <default>` from catch, `.catch(() => {})` on writes
that matter, `?? <literal>` standing in for failed/missing data — that
**swallows failures and makes broken pipelines look healthy**. Remove it.

**Doctrine — fail fast inside, handle at the boundary.** Inner code throws typed
errors; it does not catch-and-continue. Only designated boundaries translate
those errors into a structured failure, a user-facing error state, or an
escalation. This is crash-only design (Candea & Fox, "Crash-Only Software",
HotOS IX 2003): transparent recovery at a designed boundary beats ad-hoc
continue-on-error in every function. A failure must surface **observably** —
either the **agent** sees it (and can retry / reconfigure / disable the failing
feature) or it is **raised to the owner/developers** when systemic.

**"Not loaded" must never read as "zero"/"empty".** A `?? 0`, `?? []`, `?? ""`,
or `return 0`/`return []` from a catch that substitutes for failed or missing
data conflates a broken pipeline with a legitimately empty result. Banned. DTO
fields are required by default; fix the pipeline, don't paper over it.

**Fast-fail on data paths; throw, never fabricate.** Precedent: issue #9324
(closed) removed fabricated zero/marker embedding vectors in favor of throwing;
`plugins/plugin-embeddings/AGENTS.md:32` codifies "THROW, never fabricate".

**UI three-state rule.** `loading` / designed-`empty` / `error` are three
distinguishable renders — never render healthy-empty from a catch. A
404-from-unloaded-plugin may degrade to a designed "unavailable" state (J4);
5xx/transport/parse failures set an error state. Canonical pattern:
`packages/ui/src/components/pages/StreamView.tsx:55-63`; repaired load shape:
`packages/ui/src/state/usePluginsSkillsState.ts:195-220`. See the view audit
`scripts/view-audit/output/MASTER-REPORT.md` §6.A/§6.D.

**Use the foundation.** New/rewritten throw sites use `ElizaError`
(`packages/core/src/errors.ts`, `{ code, context, cause, severity }`).
Diagnostic call sites outside the action path (providers, services, background
jobs, event handlers) call `runtime.reportError(scope, error, context?)` — it
logs, emits `EventType.ERROR_REPORTED`, surfaces the failure to the agent via
the `RECENT_ERRORS` provider, and drives owner escalation on repeated systemic
failure. Action/tool failures already reach the model via the planner loop —
keep that.

### Justified categories (J1–J7) — keep, annotated `// error-policy:J<N> <reason>`

Every kept handler carries a grep-able `// error-policy:J<N> <reason>` comment
so "remaining handlers each have a documented justification" is mechanically
checkable. A justified handler still may not fabricate a success value: J1
returns a *failure*, J3 returns an explicit *invalid* signal, J4 renders an
*error/unavailable* state.

- **J1 boundary translation** — one outermost handler per process/transport
  boundary producing a structured failure.
- **J2 context-adding rethrow** — must use `cause`.
- **J3 untrusted-input sanitizing** — parse failures produce an explicit typed
  "invalid" result, never a fake-valid default.
- **J4 explicit user-facing degrade** — designed, visually-distinguishable
  unavailable/error states; only expected error shapes degrade.
- **J5 unhandled-rejection suppression** — with a comment naming where the
  rejection IS observed.
- **J6 best-effort teardown** — debug/warn, teardown paths only.
- **J7 diagnostics-must-not-kill-the-loop** — trajectory/telemetry writes may
  catch but must warn + `runtime.reportError`.

Everything else is slop — including every empty catch, log-and-continue that
fabricates the function's result, `return <default>` from catch,
`.catch(() => {})` on writes that matter, `?? <literal>` substituting for
failed/missing data, optional-chaining-as-guard on required collaborators, and
fallback code paths whose only purpose is masking a primary failure. Every catch
without an annotation must be either newly-obvious slop or a J1 route boundary in
a directory documented as such in the batch PR.

**Regression guard (diff-scoped ratchet).** `bun run audit:error-policy-ratchet`
compares every production source file the branch touches against that file's own
content at the merge-base with `origin/develop`, and fails only when a touched
file **adds** an empty catch or server-side `console.*` call. It is immune to
unrelated `develop` drift (files the branch does not touch are never counted)
and is a no-op on `develop` itself. Run `... --report` for the repo-wide totals
the #12182 sweeps drive down. Logger only, never `console`, in server code.

## Slop and Comment Cleanup

Every file is legible on its own: a purpose-explaining prose header at the top,
then in-body comments that explain **why the code is the way it is** — the
design rationale, the constraint that forced the approach, what consumes it —
never a restatement of *what* it does. The reader can read the code; a comment
earns its place only by adding what the code cannot show. No change-narration.
Write for the next engineer opening this file cold in a **greenfield** codebase:
there is no legacy to apologize for and no diff history to narrate — these
comments are the codified, durable explanation of the system. The rules below
are binding for new code and for the repo-wide cleanup (#12181).

1. **Header form — one `/** … */` prose block at the very top** (after a `#!`
   shebang; after a third-party license block in the few files that carry one;
   before imports). Plain prose, not a template: no `@fileoverview`, no
   `@author`/`@date`/`@version`. Position is the signal.
2. **First sentence states what the file does in system terms; never repeat the
   filename** ("Local content-addressed media store for chat attachments.").
   Then, only as warranted, give the reader a sense of the file's place in the
   system: **who consumes it and what it consumes** (the boundary it sits on),
   the invariants/constraints it must uphold, why it is shaped the way it is, and
   gotchas to know before editing. Issue refs like `(#9948)` are welcome when
   they anchor non-obvious rationale — never as a substitute for stating it.
3. **Length scales with weight, hard ceiling ~25 lines.** Barrel `index.ts` /
   tiny type files: 1 line. Typical modules: 2–6 lines. Load-bearing modules:
   2–3 short paragraphs. Longer than that belongs in the package
   `CLAUDE.md`/`README.md` — reference it instead. Test files: 1–3 lines — what
   surface is under test and how real the harness is (live model vs
   deterministic proxy, real DB vs in-memory).
4. **In-body comments explain the *why*, never the *what*.** The reader can see
   what the code does; a comment earns its place only by adding what the code
   cannot show — the design rationale (why this approach and not the obvious
   alternative), the invariant or constraint that forced it, units and boundary
   conditions, protocol quirks, ordering constraints, and non-obvious
   consequences for callers. Keep the two-tier split — `/** JSDoc */` on exported
   symbols (for callers), `//` for implementation notes. Delete restatement,
   change-narration, status updates, migration stories, and commented-out code.
   Do not blanket-comment: a file whose code is clear needs a header and nothing
   else.
5. **Churn test = durability test.** Would the comment be true and useful to
   someone who never saw the previous version? If it only makes sense as a diff
   annotation, delete it; if the fact is durable but churn-phrased, rewrite it to
   present tense. History lives in git.
6. **Accuracy over coverage.** A wrong header is worse than no header. Read the
   package's `CLAUDE.md` first; if a file's purpose can't be determined, flag it
   in the PR instead of guessing.

Copy the tone from these in-repo exemplars, don't invent one:
[`packages/agent/src/api/media-store.ts:1`](packages/agent/src/api/media-store.ts)
(service), [`packages/ui/src/components/RoleGate.tsx:1`](packages/ui/src/components/RoleGate.tsx)
(React component), [`packages/scripts/run-all-tests.mjs:1`](packages/scripts/run-all-tests.mjs)
(script — but don't copy its filename-repetition opener), and `.gitmodules`
(config prose). Never touch code, string/template literals, third-party license
blocks (header goes below them), or generated files. Comment-only changes are
machine-checked by `bun run check:comment-only`
([`scripts/assert-comment-only-diff.mjs`](scripts/assert-comment-only-diff.mjs)):
it asserts the code token stream is byte-for-byte unchanged.

## App visual review — REQUIRED for UI changes in `packages/app/`

Any change in `packages/app/` (or a shared package whose UI bleeds into it) MUST
pass the screenshot + manual-review loop before it is "done":

```bash
bun run --cwd packages/app audit:app
```

This walks the app views (desktop + mobile, rest + hover), captures the
populated UI, and auto-stubs `aesthetic-audit-output/manual-review/<slug>.md`
per view. Fill in the verdict (`good` · `needs-work` · `needs-eyeball` ·
`broken`) for every page you touched or can reach via shared
layout/theme/components.

- No page may stay `needs-work` / `broken` when a UI task is declared done.
- Iterate the loop ≥5× for any meaningful redesign.
- Orange is accent only; no blue anywhere; orange-resting → darker-orange hover
  (never orange→black). Full package rules: `packages/app/AGENTS.md`.

## LifeOps + health: one scheduler, structural behavior

`@elizaos/plugin-personal-assistant` and `@elizaos/plugin-health` share one
scheduled-item architecture. Reminders, check-ins, follow-ups, watchers,
recaps, approvals, and outputs are all `ScheduledTask` records routed through a
single runner (`plugins/plugin-scheduling/src/scheduled-task/runner.ts`),
which pattern-matches on structural fields (`kind`, `trigger`, `shouldFire`,
`completionCheck`, `pipeline`, …), never on `promptInstructions` text. Health
contributes through registries; LifeOps does not import its internals.

For the full automation vocabulary — how a **workflow**, **trigger**, **task**,
**scheduled item**, **coding task**, and **automation** differ and what fires
each (one clock, two consumers) — see [`docs/automation-glossary.md`](docs/automation-glossary.md).

**Do not add:** a second LifeOps scheduling mechanism, a second knowledge-graph
store (use `EntityStore` / `RelationshipStore`), behavior driven by
`promptInstructions` string content, a `boolean` return from a connector
dispatch (use the typed `DispatchResult`), or an identity-merge that bypasses
the merge engine. Architecture, frozen contracts, and contribution paths live in
`plugins/plugin-personal-assistant/README.md` and `plugins/plugin-health/README.md`.

## Attachments & files: one content-addressed store, additive model

Attachment bytes live in a **single content-addressed store** —
`packages/agent/src/api/media-store.ts` (`${STATE_DIR}/media/<sha256>.<ext>`,
served at `/api/media/<sha256>.<ext>`). The sha256 URL is the canonical,
unguessable, deduped handle; `Media` (`packages/core/src/types/primitives.ts`)
is the in-message reference and is widened **additively only**. Bytes are served
pre-auth (the hash is the capability), with `nosniff` + a download
`Content-Disposition` for SVG/active types; every server-side attachment fetch
must go through the SSRF guard (`packages/core/src/network` + `media/fetch.ts`).

**Do not add:** a second file store or storage abstraction/selector; a
`files`/`file_references` DB table or a refcount/GC engine (the store already
GCs via `gcUnreferencedMedia` + a grace window); a `fileId` on `Media`; a
rewrite/rehost on the pre-auth serve path (rehost only on authenticated write);
or a repurpose/removal of a `ContentType` enum value (it is **frozen,
append-only** — derive fine-grained kind from `mimeType` at read time). Scope,
deferrals, and rationale live in issue #8876.

## Definition of Done — sync, PR, and human-verifiable evidence

Every fix/feature ships through a **PR against `develop`**, and a reviewer must
be able to confirm it works **without reading the code**. Full standard:
[`PR_EVIDENCE.md`](PR_EVIDENCE.md) — read it; it is binding. **The same standard
is restated in every package's `CLAUDE.md` / `AGENTS.md` and is non-negotiable.**

**The three laws of "done"** (the whole standard expands these):

1. **Prove the real thing happened — and look at it yourself.** Record the
   actual model trajectories (inputs *and* outputs from a **live** model, not the
   proxy, not a mock), the real client + server logs, the real pixels/audio, and
   the real domain artifacts (memories, knowledge, DB rows, scheduled tasks,
   wallet balance, on-chain results, generated files). Then **open every artifact
   and review it by hand.** Capturing is not reviewing; green CI is not proof.
2. **Test everything for real — no larp.** Every change ships detailed,
   full-featured **end-to-end** tests that drive the *real* path — not the happy
   "front door" only. Cover error paths, edges, empty/invalid input, concurrency,
   roles/permissions, and adversarial input. A test asserting against a
   mock/stub standing in for the thing under test does **not** count; if the real
   model/device/chain/connector is hard to reach, make it reachable — that's the
   work. If the existing tests you touch are shallow or mocked, fixing them is
   part of your change. (See the standing backlog: #9943, #9950, #9954, #9958,
   #9967, #9970.)
3. **No residuals, no shortcuts.** The goal is not "done," it is *everything*
   done. Clear blockers by the **hard path** — build the real architecture, stand
   up the real model/device/service, actually test it. No TODOs, stubs,
   stepping-stones, or "follow-ups." When unsure, research, weigh options, and
   ship the best production-ready version. Keep going until every possibility is
   exhausted.

The non-negotiables in practice:

- **Always PR; never push feature/fix work straight to `develop`.** Branch as
  `feat|fix|docs|chore/<slug>`; open an issue first for anything non-trivial.
- **Always sync before opening or updating a PR.** `git fetch origin &&
  git rebase origin/develop`, resolve **every** conflict, `bun install`, then
  `bun run verify`. A branch that can't fast-forward onto `develop` is not ready.
- **Frontend-testable changes are not done without rendered proof.** Any change a
  user can exercise in the web, desktop, mobile, or cloud UI must attach a video
  walkthrough; before and after full-page screenshots for desktop and mobile;
  backend structured logs; frontend console and network logs; and real-LLM
  trajectories when agent/action/provider/prompt/model behavior changes. If one
  row does not apply, keep it visible and write `N/A - <reason>` in the PR and
  issue evidence.
- **Attach complete, real, manually-reviewed evidence** — prove the real thing
  happened, not a mock of it:
  - **Real-LLM trajectories** for agent/action/prompt/model changes —
    `packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`
    against a **live** model (JSON report + run viewer + native jsonl) — **and
    read them.**
  - **Backend logs** (structured `[ClassName] …`) and **frontend logs**
    (console + network) showing the actual code path firing.
  - **Before/after full-page screenshots** (desktop + mobile) + a **video
    walkthrough** of the whole flow — `bun run test:e2e:record`; for app UI,
    `bun run --cwd packages/app audit:app`.
  - **Per-platform capture** (screenshot + recording + logs) for native/mobile/
    desktop changes — `bun run --cwd packages/app capture:ios-sim` /
    `capture:android-emu` / `capture:linux-desktop` / `capture:windows-desktop`,
    electrobun `GET /api/dev/cursor-screenshot`. Run native features on the real
    device/simulator/platform matrix, not mocked-bridge desktop Chromium. Full
    surface→command matrix in `PR_EVIDENCE.md`.
  - **Always build + deploy the latest before capturing.** Capture helpers
    screenshot whatever is **already installed/running** — they do not build.
    Before any on-device/simulator/desktop capture, rebuild and redeploy the
    current tree (mobile: `build:android` / `build:ios` cap sync **and
    reinstall** — a Capacitor app bakes the web bundle into the APK/IPA at build
    time, so restarting the old app never picks up a renderer change). Confirm
    the running build is yours (`versionName` / a known on-screen change) — a
    screenshot of a stale install proves nothing.
  - **Audio + narrated walkthrough** for voice/transcript/TTS/STT changes.
  - **Domain artifacts** — the things the change produced (memory/knowledge/DB
    rows, scheduled tasks, wallet balance before/after, on-chain tx hashes,
    generated files, device output) — inspected by hand and shown.
  - Artifacts land in `.github/issue-evidence/<issue#>-<slug>.<ext>` (see that
    dir's `README.md`). Each evidence type is attached **or** explicitly marked
    N/A with a reason — never left blank. If `develop` moved and changed
    behavior, **re-capture** evidence; stale proof is worse than none.

## Contributing

Open an issue before a non-trivial PR. License: MIT (`LICENSE`). Security
policy: `SECURITY.md`. Shipping standard: `PR_EVIDENCE.md`.
