# Contributing

Every contributor, person or agent, reads [AGENTS.md](AGENTS.md) in full before any work, and the skill or file its ["Where the rest is"](AGENTS.md#where-the-rest-is) names for the work at hand.
Starting a project from the template is [README.md, "Set up a new project"](README.md#set-up-a-new-project).
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
| `pnpm verify` | what CI runs: build, types, tests, browser tests, every `check`, lint, `pnpm analyze` and `pnpm selftest`, which also installs and checks each example |
| `pnpm all <task>…` | one or more kinds of task in every package: `pnpm all build typecheck test` |
| `pnpm test:browser` | the browser tests |
| `pnpm test:models` | every workspace `check`: the root's, which is its owners' too, and Studio's |
| `pnpm lint` | ESLint and Stylelint (`pnpm lint:js`, `pnpm lint:css` for one) |
| `pnpm analyze` | Knip (unused files, exports, dependencies), Madge (import cycles) and jscpd (duplicated code) |
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
| `vibestack/spec.ts`, `vibestack/pipeline.ts` | the `spec` command, and the pipeline it runs |
| `vibestack/parse.ts`, `vibestack/review.ts` | literate specs and the review ledger |
| `vibestack/cache.ts`, `vibestack/run.ts` | stage caches and bounded tool execution |
| `vibestack/units.ts`, `vibestack/simulate.ts` | generation, proof units, simulation and replay |
| `vibestack/util.ts` | source discovery, the `tests` stage and the rules it holds tests to, and citations |
| `vibestack/gen/vibe.ts` | `gen/<name>.effect.vibe`, read off the generated TypeScript |
| `vibestack/gen/react.ts` | `gen/<name>.react.ts` (`useMachine`), in a package that depends on React |
| `vibestack/scan.ts` | how a spec's lines are read; imports nothing, so Studio's page uses it too |
| `vibestack/studio/` | Studio, a workspace package with its own spec, checked by `pnpm --filter vibestack-studio check`: change `spec/`, then its shell in `src/` |
| `vibestack/prove.ts` | proves one unit: checks and splices the proof file, runs LemmaScript and `dafny audit`, verifies again with every assertion isolated each definition that fails, and alone every postcondition a failing one could hide |
| `vibestack/proof/lib.dfy` | the library proof files call |
| `vibestack/std/` | specs that ship with the tools, which any spec may import, each with its proof file |
| `vibestack/conform.ts` | the `traces` stage: drivers, each in a Node of its own, `driver:` programs and recorded traces; saved counterexamples; the driver stub |
| `vibestack/explore.ts` | the `explore` stage: serves a package's page with its app script, runs Bombadil on it, and replays and removes a saved run |
| `vibestack/conformance.ts` | the comparing: journeys, malformed-input probes, walks, shrinking and replay; copied into `gen/` for a driver's types |
| `vibestack/testing/` | what packages import: `project()` (the Vitest configuration), the property-test generator, `effectDriver` |
| `vibestack/stories/`, `vibestack/design/` | generated stories and their tests; design tokens and their lint rules |
| `vibestack/gen.ts` | the translator: reads what a module imports and defines |
| `vibestack/gen/types.ts` | everything decided by a type |
| `vibestack/gen/print.ts` | expressions |
| `vibestack/gen/classify.ts` | which definition is a transition, a guard or a rule |
| `vibestack/gen/secrecy.ts` | where a secret may go |
| `vibestack/gen/typescript.ts`, `vibestack/gen/harness.ts` | `gen/<name>.ts`, and the Quint module `gen/<name>.run.qnt` that simulation runs |
| `vibestack/selftest.ts`, `vibestack/fixtures/` | the selftest and the specs it uses besides the order example |

Node runs all of it directly; `pnpm build` compiles it for the packaged `spec` command.

`check(root)` returns `{ ok, results, next }`, and `spec check --json` prints each result as one line of JSON as soon as
it is reported, then that object as its last line. Each result has `ok`, `stage` (a stage, or `skipped`), `summary`,
`detail` and, when it concerns them, `where` and `rules` (each rule as `{ file, key }`); `next` is the line the command
line ends with. `pnpm selftest` builds scratch projects from this project's spec or from `vibestack/fixtures/`, breaks
one thing at a time and asserts which stage catches each. It runs as three cached tasks, each keyed by what its tests
read: `selftest:docs` the documents against every file they can name, `selftest:examples` each standalone example
against its own files and the tools, and `selftest:tools` everything else, which no example but the order one reaches.
`pnpm selftest` runs all three through Turborepo, as `pnpm verify` does. What a change to the
tools owes it, and the sync skill, is in [AGENTS.md, "Definition of done"](AGENTS.md#definition-of-done).

## Releasing

Set `version` in the root `package.json`, merge to `main`, and push the tag `v<version>` from it.
`.github/workflows/release.yml` builds, packs with `pnpm pack`, runs `pnpm selftest`, which the shared cache answers for a commit CI has verified, and attaches the tarball to a GitHub release of that tag.
A project installs it as [README.md, "Using it from another package"](README.md#using-it-from-another-package) says.
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
| Generated TypeScript | `gen/<name>.effect.vibe`; `gen/<name>.react.ts` (`useMachine`) in a package that depends on React; driver types in `gen/<name>.conformance.ts` over `gen/_conformance.ts` | `spec gen`; no |
| A shell importing `apply`, with no driver | `test/drivers/<name>.ts`, a stub to fill in | `spec check`; yes, once filled in |
| `src/**/*.schema.{ts,vibe}`, `src/**/*.contract.{ts,vibe}` | `.cache/generated/tests/` | `vibestack/testing/generate.ts`, before each package test run on `project()`; no |
| Component props and `*.meta.tsx` | Stories, catalog and interaction/accessibility tests in `generated/stories/` | `vibestack/stories`; no |
| `packages/design-system/tokens.json` | Theme CSS in `packages/design-system/generated/` | `vibestack/design`; no |
| `vibestack/` | Packaged `spec` command in `dist/` | `pnpm build`; no, included in the package |
| A person's review | `spec/lock.json` | `pnpm accept`; yes |
| A journey or walk that disagrees with the application | `test/counterexamples/<name>/` | `traces`; yes, replayed before later walks |
| An exploration that broke a property | Bombadil's run of the page in `test/__traces__/bombadil/` | `explore` (`vibestack/explore.ts`); no, replayed first and removed once it breaks nothing |

The adapter and driver types read the generated model; `traces` uses events
found by the simulator; property tests read schemas and contracts. Generated
outputs are never edited by hand. A driver reaches the real application and
imports `gen/` only as types, so it does not compare the model with itself.

### Caching

Core generation produces deterministic code. It, and the story and property-test
generators, write files only when their bytes change and remove outputs whose
sources have gone: a check that changes no spec leaves `gen/` and the owners'
`gen/` untouched, so nothing that watches them rebuilds. A check loads each
generated module from its own `.spec-cache/run-<time>/`, removed when it ends. `.spec-cache/`
remembers each run of Quint, and of LemmaScript and Dafny on a proof, under the program as installed, its arguments and
the files it reads, without their prose, comments and layout (`vibestack/action.ts`),
and each simulation and proof result under a fingerprint of a spec and its
imports, the versions of the programs beneath (Quint and Node for a
simulation; Node, LemmaScript, Dafny and Z3 for a proof, whose key holds the
whole unit) and the code of only the tools that stage runs: `simulate.ts`,
`units.ts` and what they import, or `prove.ts` and what it imports, each read
as its tokens and line breaks, so that rewording a comment in a tool runs
nothing again. A
simulation cites each rule at the line it is on now, so prose that only moves
the rules simulates nothing again. The programs and their versions are read
for each key, so a process that outlives a reinstall, as `watch` does, runs and
remembers under the programs installed now. A run
of a tool is remembered when it reached its answer, a refusal of its input
included, never when it was stopped, timed out or failed for want of a file or
program: an unchanged unit whose proof failed runs neither again, and an edit
to a proof file only checks and verifies the Dafny it changes. A unit offered
what the units it imports proved is proved once when their results are
remembered, and meanwhile, to be proved again if they fail, only while one of
them is still being proved. A test run
may run any tool, as Studio's do, so it is keyed by all of them, and with a
typecheck, a driver's run and an exploration by VibeLang's version and bytes.
An exploration is keyed by the code that explores and what its page reads
(`pageInputs` in `vibestack/explore.ts`), which holds every tool when the
page runs one, as Studio's does.
It also remembers a package's passing test run under a hash of what its tests
read; a driver's passing run under the same hash and the events the simulator
found; and a passing typecheck under the package's files without its Markdown,
Quint and Dafny, its `tsconfig.json` chain and included files, and each file outside
`node_modules` that the compiler listed as read. `watch` checks again when any
file of the root or an owner changes, is added or is removed, outside `gen/`
and the directories no stage reads (`node_modules`, build output, saved
explorations, hidden directories), since a missed change would leave a stale
pass on screen; it does not check again for a file the last check wrote
itself, such as a driver to fill in or a saved counterexample, while the file
still holds what it wrote. `spec.ts` turns on Node's compile cache before it
loads the pipeline, so each `spec` process, Studio's checks and Turborepo's
tasks included, compiles only the tools that changed.

Turborepo caches `gen`, `build`, `typecheck`, tests, selftest and lint according
to `turbo.json`. The task entry point fingerprints Node, VibeLang, Dafny, Z3
and their runtime files before Turbo hashes its inputs. What it reads of an
installed file, and Dafny's version, is remembered across processes in
`$XDG_CACHE_HOME/vibestack` (`~/.cache/vibestack` by default) while the file's
device, inode, size and modification and change times stay the same, so an
unchanged toolchain is not read again. Generated stories,
browser build artifacts, compiler declarations and successful test receipts
are restored with their owning task. `check` is never skipped whole: its
`driver:` programs run the real application in `traces` every time. Standalone examples install and check
separately, outside the workspace cache.

A complete passing Vitest run records its input fingerprint. `check` reuses
that result only while its source, generated core, transitive workspace
inputs, lockfile and fixed profile match. The fingerprint covers the package's
files, with the packages nested under its `test/` as fixtures but not other
nested packages, and of each `workspace:` dependency what a dependent can
load: not its `spec/`, Markdown, tests, drivers, traces, counterexamples or
nested packages, nor its `gen/` unless its code or manifest reaches into it; a
file a test reads from elsewhere comes through a declared dependency, as the
root's `@repo/design-system` does. A typecheck is keyed by the scripts and
JSON alone, and then by the content of every file the compile read. Turbo's
`//#test` inputs cover the same files but the root's Markdown, so a restored
receipt matches unless only a document changed, and then `check` runs the root's
tests itself. Generated code names each rule by its heading, not its line, so
prose that only moves a rule changes none of these keys. Filtered, exclusive, interrupted
and failed runs record no complete result. Acceptance and nightly checks
bypass these receipts and the inner verification cache.

The spec cache retains recent branch and profile results for 30 days within
256 MiB, evicting the oldest unused results first. A check's own entries are
preserved. Proof identity covers the verifier and solver contents, so moving
an identical installation does not invalidate it and replacing an executable
with the same version does; tests, drivers and explorations are keyed by the
verifier too, since they may run proofs, as Studio's do. A process that
outlives a reinstall, as `spec watch` does, reads Quint, LemmaScript and Dafny
again once their installed files change. In CI, a Turborepo cache entry is
kept for seven days after its last hit, which the run summary names.

### Seeds and budgets

`vibestack/testing/profile.ts` is the one source of the fixed profiles:

| Invocation | Values per property and maximum driver walks | Seed | Seconds exploring each page |
|---|---:|---:|---:|
| normal local checks and every pull request or push | 1,000 | 1 | 60 |
| `pnpm all check -- --nightly` | 20,000 | 2 | 300 |

A driver's `options.walks` can impose a smaller maximum for an expensive
journey. Quint mixes the selected profile's seed into its model-derived
seeds. The nightly command always performs fresh verification; it does not
reuse an earlier nightly pass. `FUZZ_RUNS` and `FUZZ_SEED` do not configure
these checks. A failing property prints its fixed-profile replay command;
a driver's shrunk counterexample is saved and replayed on every later run
([SPEC.md, "Conformance"](SPEC.md#conformance)).

Exploring a page is bounded by time, Chrome's start included, not by a
count, and Bombadil takes no seed: two runs try different actions. What a
failing exploration found is saved and replayed instead
([SPEC.md, "Exploring the page"](SPEC.md#exploring-the-page)).

### Which test, for what

[AGENTS.md, "Tests"](AGENTS.md#tests) defines what earns a test and the rules
`check` enforces. The hello world in `apps/app` demonstrates each kind.

| Kind | Checks | Source or example |
|---|---|---|
| Formal | Rules and laws for every state and input | `spec/app/`; `.proof.dfy` where Dafny needs help, such as `spec/app/echo.proof.dfy` and `src/greeting.proof.dfy` |
| Model-based | Real shell against the spec: journeys, malformed input, walks and saved counterexamples | `test/drivers/app.ts` and the recorded `test/traces/app.jsonl`, run by `traces` |
| Journey/integration | A story through real services, including what a driver cannot see | `@effect/vitest` in `test/app.test.vibe`: reload from storage |
| Component/browser | Story interactions and accessibility; browser-only behavior such as focus and storage | Component metadata `play`; `test/app.browser.test.tsx` in Chromium |
| Exploratory/browser | The served page under random clicks, typing, scrolling and reloads: no uncaught error, console error or failed request, and the properties each rule gives the page, in every state reached | `test/bombadil.ts`, or nothing for Bombadil's defaults; `apps/app/test/bombadil.ts`, run by `explore` |
| Property | What a schema or declared contract promises for generated values | Generated from `src/link.contract.ts` and other `*.schema.*` or `*.contract.*` files |

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
| Runtime tested | The journeys, properties, conformance walks and explorations that ran passed | Untested inputs |
| Not verified | Effects, timing or third parties outside test coverage | An assurance about those behaviors |

Asynchronous Effect programs are tested, not proved. Each `proof` line says
how many obligations are proved and how many are simulated only.

ESLint enforces package exports and the stack boundaries. Knip finds unused
files, exports and dependencies, reading `.vibe` and `.vibex` through VibeLang's
compiler. Madge checks cycles in `.ts` and `.tsx` imports. jscpd fails on any
duplicated block of code outside the examples and test fixtures. Their
configured scopes are in `knip.config.js`, `.madgerc`, `.jscpd.json` and
`eslint.config.js`.

### CI

| When | Runs |
|---|---|
| Pull request or push to `develop` or `main` | `pnpm verify --continue`: build, types, tests, browser tests, all checks, ESLint, Stylelint, Knip, Madge, jscpd and selftest |
| Nightly | Every check fresh under the fixed nightly profile; saved counterexamples become a pull request into `develop` |
| A `v*` tag (`release.yml`) | Build, `pnpm pack`, `pnpm selftest` read from the shared cache, and the tarball attached to a GitHub release |

Each row's budget is in [Seeds and budgets](#seeds-and-budgets). A failing
run keeps `test/counterexamples/` and `test/__traces__/`, where a broken
exploration is, as an artifact.

Each run restores pnpm's store, every `.spec-cache/`, and Quint's evaluator.
Turborepo shares task results through the private Cloudflare/R2 cache.
The task entry point disables Turbo telemetry. `selftest:tools` waits for the root and
Studio test tasks so those integration journeys do not compete with it.
Pull requests read shared results; only branch pushes receive the publishing
credential, protected by the `turbo-cache-publish` environment's branch
policy. A pull request keeps its own Turborepo results in the GitHub cache
instead, which only that pull request reads, so its next push reuses them. Newer commits replace an older run of the same pull request.
Every pushed commit can finish. Completed tasks are shared through the cache.
Local `pnpm` task commands read the operator's cache credential from
`~/.config/vibestack/turbo-cache.json`, outside the repository. Credentials
are never part of a task fingerprint.

The standalone examples are the tools' own subjects: `pnpm selftest` installs
each from its own lock file and runs its `check`, its page explored where it
has one. An application built on the tools never checks them: its `check`
reaches only its own packages, and the packed toolchain carries no example.
