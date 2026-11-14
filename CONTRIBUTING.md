# Contributing

Every contributor, person or agent, reads [AGENTS.md](AGENTS.md) and [README.md](README.md) in full before any work.
How the repository works is in [AGENTS.md](AGENTS.md); starting a project from the template is [README.md, "Set up a new project"](README.md#set-up-a-new-project).
Everything is built on [the stack](AGENTS.md#the-stack): Node 26, pnpm, VibeLang on Effect for the shell, React for every interface.

## The monorepo

| Path | Holds |
|---|---|
| `apps/` | deployable applications; `apps/app` is the hello world to replace |
| `packages/` | what applications share: `@repo/ui` (components), `@repo/design-system` (tokens) |
| `vibestack/` | the tools: the `spec` command, Studio, and what any project uses but does not own (`vibestack/testing`, `vibestack/design`, `vibestack/stories`) |
| `vibestack/examples/` | standalone projects, each with its own install; never part of the workspace |

The specs of every package are in the one tree at the root ([SPEC.md, "One spec tree"](SPEC.md#one-spec-tree));
[Architecture](#architecture) maps what is generated from what, which test is for what, and the
budgets and CI.

A package states what it offers in `exports`; import a package by name, never by a path into its `src/`. Domain code
does not import React, and a UI package holds no business rules. A shared type lives with the contract that owns it.

| Command | Does |
|---|---|
| `pnpm dev` | Studio, and every package's `dev` script beside it |
| `pnpm quick` | the fast local check: types, tests, ESLint and Stylelint, in every package |
| `pnpm verify` | what CI runs: build, types, tests, browser tests, every `check`, lint, Knip, Madge and `pnpm selftest` |
| `pnpm all <task>…` | one or more kinds of task in every package: `pnpm all build typecheck test` |
| `pnpm test:browser` | the browser tests |
| `pnpm test:models` | every `check`: the root's, which is its owners' too, Studio's, and the examples' |
| `pnpm examples` | each example's install and `check` |
| `pnpm lint` | ESLint and Stylelint (`pnpm lint:js`, `pnpm lint:css` for one) |
| `pnpm analyze` | Knip (unused files, exports, dependencies) and Madge (import cycles) |
| `pnpm check`, `pnpm gen`, `pnpm build`, `pnpm typecheck`, `pnpm test` | this package's own, here as in every package: at the root, the root project and the tools |

Turborepo (`turbo.json`) orders these and skips a task whose inputs it has seen
([Caching](#caching)), so every command above runs only
what a change reaches. `check` is never skipped whole: `spec` keeps its own finer cache in `.spec-cache/`, and runs the
application again each time.

A package joins by having a script named `gen`, `build`, `typecheck`, `test`, `test:browser` or `check`. Its other
tasks wait for its `gen` and the root's, and its `check` for all of them, since `check` rewrites `gen/`. The root's
`check` rewrites its owners' `gen/` too, so it waits for their tasks: name each owner's in `//#check` of `turbo.json`,
as `@repo/app`'s are. `pnpm lint:js` on its own needs what `gen` and `typecheck` write (`gen/`, `.vibe/declarations`);
`pnpm lint` runs them first.

Pull requests go to `develop`, and `develop` to `main`; what CI runs on each is in
[CI](#ci).

## Changing the tools

| File | Role |
|---|---|
| `vibestack/spec.ts` | the pipeline and the `spec` command |
| `vibestack/parse.ts`, `vibestack/review.ts` | literate specs and the review ledger |
| `vibestack/cache.ts`, `vibestack/run.ts` | stage caches and bounded tool execution |
| `vibestack/units.ts`, `vibestack/simulate.ts` | generation, proof units, simulation and replay |
| `vibestack/util.ts` | source discovery, the `tests` stage and the rules it holds tests to, and citations |
| `vibestack/gen/vibe.ts` | `gen/<name>.effect.vibe`, read off the generated TypeScript |
| `vibestack/scan.ts` | how a spec's lines are read; imports nothing, so Studio's page uses it too |
| `vibestack/studio/` | Studio, a workspace package with its own spec, checked by `pnpm --filter vibestack-studio check`: change `spec/`, then its shell in `src/` |
| `vibestack/prove.ts` | proves one unit: checks and splices the proof file, runs LemmaScript and `dafny audit`, and rechecks alone every postcondition a failing one could hide |
| `vibestack/proof/lib.dfy` | the library proof files call |
| `vibestack/std/` | specs that ship with the tools, which any spec may import, each with its proof file |
| `vibestack/conform.ts` | the `traces` stage: drivers, each in a Node of its own, `driver:` programs and recorded traces; saved counterexamples; the driver stub |
| `vibestack/conformance.ts` | the comparing: journeys, malformed-input probes, walks, shrinking and replay; copied into `gen/` for a driver's types |
| `vibestack/testing/` | what packages import: `project()` (the Vitest configuration), the property-test generator, `effectDriver` |
| `vibestack/stories/`, `vibestack/design/` | generated stories and their tests; design tokens and their lint rules |
| `vibestack/gen.ts` | the translator: reads what a module imports and defines |
| `vibestack/gen/types.ts` | everything decided by a type |
| `vibestack/gen/print.ts` | expressions |
| `vibestack/gen/classify.ts` | which definition is a transition, a guard or a rule |
| `vibestack/gen/secrecy.ts` | where a secret may go |
| `vibestack/gen/typescript.ts`, `vibestack/gen/harness.ts` | the two outputs |
| `vibestack/selftest.ts`, `vibestack/fixtures/` | the selftest and the specs it uses besides the order example |

Node runs all of it directly; `pnpm build` compiles it for the packaged `spec` command.

`check(root)` returns `{ ok, results, next }`, and `spec check --json` prints that object. Each result has `ok`,
`stage` (a stage, or `skipped`), `summary`, `detail` and, when it concerns one, `where`; `next` is the line the command
line ends with. `pnpm selftest` builds scratch projects from this project's spec or from `vibestack/fixtures/`, breaks
one thing at a time and asserts which stage catches each; it is a cached task of `pnpm verify`. What a change to the
tools owes it, and the sync skill, is in [AGENTS.md, "Definition of done"](AGENTS.md#definition-of-done).

## Architecture

The spec owns the rules and state; generated code is its runtime contract.
Pure logic Quint cannot express lives in `src/**/*.ts` with proved `//@`
contracts. VibeLang owns effects and I/O; React reads the generated `Machine`
service through hooks. Persisted data enters through `decodeState` or a
schema, never by trusting stored JSON. Controls follow `enabled`, and the
shell applies events through `Machine` or the generated Effect adapter.

### Sources and generated files

Every root spec module is generated into the root's `gen/`. Modules owned by
`apps/<name>` or `packages/<name>`, and the modules they import, are also
written into that owner's `gen/`; packages import their own generated files.
See [SPEC.md, "One spec tree"](SPEC.md#one-spec-tree).

| Source | Output | Written by; kept in Git |
|---|---|---|
| `spec/**/*.md` | TypeScript core, Quint harness and Dafny under `gen/` | `spec gen`, `spec check`; no |
| Generated TypeScript | `gen/<name>.effect.vibe`, and driver types in `gen/<name>.conformance.ts` over `gen/_conformance.ts` | `spec gen`; no |
| A shell importing `apply`, with no driver | `test/drivers/<name>.ts`, a stub to fill in | `spec check`; yes, once filled in |
| `src/**/*.schema.{ts,vibe}`, `src/**/*.contract.{ts,vibe}` | `.cache/generated/tests/` | `vibestack/testing/generate.ts`, before each package test run on `project()`; no |
| Component props and `*.meta.tsx` | Stories, catalog and interaction/accessibility tests in `generated/stories/` | `vibestack/stories`; no |
| `packages/design-system/tokens.json` | Theme CSS in `packages/design-system/generated/` | `vibestack/design`; no |
| `vibestack/` | Packaged `spec` command in `dist/` | `pnpm build`; no, included in the package |
| A person's review | `spec/lock.json` | `pnpm accept`; yes |
| A journey or walk that disagrees with the application | `test/counterexamples/<name>/` | `traces`; yes, replayed before later walks |

The adapter and driver types read the generated model; `traces` uses events
found by the simulator; property tests read schemas and contracts. Generated
outputs are never edited by hand. A driver reaches the real application and
imports `gen/` only as types, so it does not compare the model with itself.

### Caching

Core generation produces deterministic code and rebuilds `gen/` to remove
stale modules. Story and property-test generators write files only when their
bytes change and remove outputs whose sources have gone. `.spec-cache/`
fingerprints a spec and its imports together with Quint, Dafny, Z3,
LemmaScript, Node and tool versions. It also remembers a package's passing
test run under a hash of what its tests read.

Turborepo caches `gen`, `build`, `typecheck`, tests, selftest and lint according
to `turbo.json`. The task entry point fingerprints Node, VibeLang, Dafny, Z3
and their runtime files before Turbo hashes its inputs. Generated stories,
browser build artifacts, compiler declarations and successful test receipts
are restored with their owning task. `check` is never skipped whole: it runs
the real application in `traces`. Standalone examples install and check
separately, outside the workspace cache.

A complete passing Vitest run records its input fingerprint. `check` reuses
that result only while its source, generated core, transitive workspace
inputs, lockfile and fixed profile match. Filtered, exclusive, interrupted
and failed runs record no complete result. Acceptance and nightly checks
bypass these receipts and the inner verification cache.

The spec cache retains recent branch and profile results for 30 days within
256 MiB, evicting the oldest unused results first. A check's own entries are
preserved. Proof identity covers the verifier and solver contents, so moving
an identical installation does not invalidate it and replacing an executable
with the same version does.

### Seeds and budgets

`vibestack/testing/profile.ts` is the one source of the fixed profiles:

| Invocation | Values per property and maximum driver walks | Seed |
|---|---:|---:|
| normal local checks and every pull request or push | 1,000 | 1 |
| `pnpm all check -- --nightly` | 20,000 | 2 |

A driver's `options.walks` can impose a smaller maximum for an expensive
journey. Quint mixes the selected profile's seed into its model-derived
seeds. The nightly command always performs fresh verification; it does not
reuse an earlier nightly pass. `FUZZ_RUNS` and `FUZZ_SEED` do not configure
these checks. A failing property prints its fixed-profile replay command;
a driver's shrunk counterexample is saved and replayed on every later run
([SPEC.md, "Conformance"](SPEC.md#conformance)).

### Which test, for what

[AGENTS.md, "Tests"](AGENTS.md#tests) defines what earns a test and the rules
`check` enforces. The hello world in `apps/app` demonstrates each kind.

| Kind | Checks | Source or example |
|---|---|---|
| Formal | Rules and laws for every state and input | `spec/app/index.md`; `.proof.dfy` where Dafny needs help, such as `src/greeting.proof.dfy` |
| Model-based | Real shell against the spec: journeys, malformed input, walks and saved counterexamples | `test/drivers/app.ts`, run by `traces` |
| Journey/integration | A story through real services, including what a driver cannot see | `@effect/vitest` in `test/app.test.vibe`: reload from storage |
| Component/browser | Story interactions and accessibility; browser-only behavior such as focus and storage | Component metadata `play`; `test/app.browser.test.tsx` in Chromium |
| Property | What a schema or declared contract promises for generated values | Generated from `src/greeter.schema.ts` and other `*.schema.*` or `*.contract.*` files |

A generated test asserts its schema or contract, never a recorded result of
its implementation. A schema without a derivable generator is reported; a
module yielding no tests fails its package's test run with the reason.
Effect's `Arbitrary` produces valid values: a driver's `receive` checks
malformed events, and journeys cover other invalid inputs that matter.
Disabled/loading stories test refusal of clicks and keys. Tests do not
compare screenshots.

### What a green check means

| Result | Establishes | Does not establish |
|---|---|---|
| Proved | Dafny proved the obligation for every state and input | Code outside the spec and `//@` files |
| Simulated only | No sampled trace broke an obligation accepted with `pnpm accept unproved` | A proof |
| Model checked within bounds | No violation in the traces and depth checked | Behavior beyond those bounds |
| Runtime tested | The journeys, properties and conformance walks that ran passed | Untested inputs |
| Not verified | Effects, timing or third parties outside test coverage | An assurance about those behaviors |

Asynchronous Effect programs are tested, not proved. Each `proof` line says
how many obligations are proved and how many are simulated only.

ESLint enforces package exports and the stack boundaries. Knip finds unused
files, exports and dependencies, reading `.vibe` and `.vibex` through VibeLang's
compiler. Madge checks cycles in `.ts` and `.tsx` imports. Their configured
scopes are in `knip.config.js`, `.madgerc` and `eslint.config.js`.

### CI

| When | Runs |
|---|---|
| Pull request or push to `develop` or `main` | `pnpm verify --continue`: build, types, tests, browser tests, all checks, ESLint, Stylelint, Knip, Madge and selftest |
| Nightly | Every check fresh under the fixed nightly profile; saved counterexamples become a pull request into `develop` |

Each row's budget is in [Seeds and budgets](#seeds-and-budgets). A failing
run keeps `test/counterexamples/` and `test/__traces__/` as an artifact.

Each run restores pnpm's store, every `.spec-cache/`, and Quint's evaluator.
Turborepo shares task results through the private Cloudflare/R2 cache.
The task entry point disables Turbo telemetry. Selftest waits for the root and
Studio test tasks so those integration journeys do not compete with it.
Pull requests read shared results; only branch pushes receive the publishing
credential, protected by the `turbo-cache-publish` environment's branch
policy. Newer commits replace an older run of the same pull request.
Every pushed commit can finish. Completed tasks are shared through the cache.
Local `pnpm` task commands read the operator's cache credential from
`~/.config/vibestack/turbo-cache.json`, outside the repository. Credentials
are never part of a task fingerprint.

Standalone examples run manually with `pnpm examples`, outside CI.
