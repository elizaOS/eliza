# Contributing

Every contributor, person or agent, reads [AGENTS.md](AGENTS.md) in full before any work, and the skill or file its ["Where the rest is"](AGENTS.md#where-the-rest-is) names for the work at hand.
Starting a project from the template is [the toolchain setup guide](vibestack/README.md#set-up-a-new-project).
Everything is built on [the stack](AGENTS.md#the-stack): Node 26, pnpm, VibeLang on Effect for the shell, React for every interface.

## Pull requests

The default branch is `main`. Open contribution pull requests against `develop`.

- Verify through the application's normal entry points that the top-level
  stories, rules, and Quint models are fully implemented and integrated.
  Keep every change in exact agreement with them. Cite the relevant stories
  and rules and show end-to-end evidence of conformance in the PR. [Top-level spec](spec/index.md)
- Run the full `pnpm verify` suite for every PR. Before merging, confirm
  that all checks passed for the latest revision, including Quint model
  checks, Dafny proofs, Bombadil exploration, and all other repository
  tests and CI checks. Report the verification results in the PR.
- For code changes, give reproduction steps and show the actual results
  before and after the change under comparable conditions. For UI changes,
  attach desktop and mobile screenshots of the same flow and state before
  and after.
- Keep the diff tidy and focused. Remove unnecessary files and dead,
  redundant, or superseded code and legacy paths. Follow the code comment
  rule in AGENTS.md; keep only its permitted machine-readable directives
  and generated component metadata.
- Satisfy all Vibestack requirements and TypeScript conventions before
  merging. [Vibestack spec reference](SPEC.md) · [Required stack](AGENTS.md#the-stack) · [TypeScript conventions](AGENTS.md#typescript-best-practices)

## Evidence

Use an `## Evidence` heading in every PR body. Put each field on its own line
with the exact name below. A Markdown bullet before the field name is optional.

- `Change types:` Use `docs` alone for documentation-only work. For other
  changes, list every applicable type from `non-ui`, `ui`, `performance`, and
  `hardware`, separated by commas.
- `Test results:` Give the tested commit, environment, exact commands, and
  observed outcomes. Link the `pnpm verify` run and identify failures and
  skips. For docs-only work, record the instructions, links, and examples
  you verified.
- `Proof of change:` Cite the affected story or rule and show what a user or
  downstream caller sees through a supported entry point. Reproduce a fix on
  the base and show it passing on the PR commit with the same inputs. For
  model or proof work, link the affected Quint, Dafny, or conformance result
  and state what it verified. For docs-only work, show the guidance gap and
  the corrected instruction.
- `Runtime logs:` For non-UI changes, attach redacted output from the affected
  runtime, toolchain CLI, integration, or agent turn. Identify the invocation
  and trace or run ID where available. Show failure and recovery for a fix.
  For model-backed behavior, include the provider and exact model ID.
- `UI video:` Attach before-and-after video of the same changed flow and state
  in the application or Studio. Include steps a reviewer can repeat.
- `UI screenshots:` Attach the required desktop and mobile before-and-after
  screenshots of the changed flow.
- `Benchmarks:` Show comparable base and PR runs for every performance claim.
  Give the command, workload, environment, samples, metric and units, and the
  before-and-after results. Report any quality change or failure.
- `On-device testing:` For a hardware-dependent change, show the affected flow
  on each changed supported physical target. Record hardware, OS, build,
  steps, and results. Report emulator or simulator observations separately.

Include the first three fields for every PR and each remaining field when its
change type applies. Use substantive output or inspectable links and remove
credentials and private data. Update evidence when a new revision affects the
result. For Slop.cash submissions, include `Made via @slopdotcash` and record
the opened PR using the [Slop.cash contributor workflow](https://slop.cash/contribute/SKILL.md).

Maintainers close PRs that fail to show a useful change. This includes added
complexity for highly unlikely paths without evidence that supported use can
reach the path and that it matters. Slop.cash deducts Points from eligible
signed submissions when its published closure and Points policy applies.

## The monorepo

| Path | Holds |
|---|---|
| `packages/` | Eliza's packages, each the owner of its `spec/<name>/`, and the toolchain's private `@repo/ui` (components) and `@repo/design-system` (tokens) |
| `vibestack/` | the tools: the `spec` command, Studio, and what any project uses but does not own (`vibestack/testing`, `vibestack/design`, `vibestack/stories`) |
| `vibestack/examples/` | standalone projects, each with its own install; never part of the workspace |

The specs of every package are in the one tree at the root ([SPEC.md, "One spec tree"](SPEC.md#one-spec-tree));
[Architecture](#architecture) maps what is generated from what, which test is for what, and the
budgets and CI.

A package exposes its code only through its root barrel (`"."` in `exports`), plus explicit non-code static assets such as `.css` and `.json`; no code subpaths or wildcards. Import a workspace package by name (or a declared static asset path), never by a code subpath or into its `src/`. Domain code
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
tasks wait for its `gen` and the root's, and its `check` for all of them, since `check` rewrites `gen/`. A package that
can never own a root spec waits for no root `gen`, so a spec edit leaves its tasks cached: Studio, which has a `spec/`
of its own, and `@repo/design-system` and `@repo/ui`, which have no `spec/<name>/`; `@repo/ui`'s tests still wait for
its stories, whose `@model` tags read the root's `gen/`. Studio's tests wait for its page build and are keyed by its
files and the `vibestack/fixtures/` they read, besides the tools every task is keyed by. The root's
`check` rewrites its owners' `gen/` too, so it waits for their tasks: name each owner's in `//#check` of `turbo.json`,
as `@elizaos/core`'s are. `pnpm lint:js` on its own needs what `gen` and `typecheck` write (`gen/`, `.vibe/declarations`);
`pnpm lint` runs them first.
`pnpm all //#analyze` also runs or restores the application and Studio generators,
the UI stories and the design theme before analysis reads their outputs.

## Changing the tools

Eliza's vendored toolchain incorporates upstream changes through [Vibestack `b7f1827`](https://github.com/lalalune/vibestack/commit/b7f1827be748d4a97aee094d9961371d553012a7), with later [page exploration](https://github.com/lalalune/vibestack/pull/271), [witness verification](https://github.com/lalalune/vibestack/pull/270), [model generation](https://github.com/lalalune/vibestack/pull/272) and [incremental story generation](https://github.com/lalalune/vibestack/pull/269) updates.
Eliza also carries its product-specific proof rendering, positive guard probes, check phase reporting,
and workspace and CI integration.

| File | Role |
|---|---|
| `vibestack/spec.ts`, `vibestack/pipeline.ts` | the `spec` command, and the pipeline it runs |
| `vibestack/parse.ts`, `vibestack/review.ts` | literate specs and the review ledger |
| `vibestack/cache.ts`, `vibestack/run.ts` | stage caches and bounded tool execution |
| `vibestack/units.ts`, `vibestack/simulate.ts` | generation, proof units, simulation and replay |
| `vibestack/util.ts` | source discovery, package fingerprints and citations |
| `vibestack/testing/check.ts` | the `tests` stage and the rules it holds tests to |
| `vibestack/gen/vibe.ts` | `gen/<name>.effect.vibe`, read off the generated TypeScript |
| `vibestack/gen/react.ts` | `gen/<name>.react.ts` (`useMachine`), in a package that depends on React |
| `vibestack/scan.ts` | how a spec's lines are read; imports nothing, so Studio's page uses it too |
| `vibestack/studio/` | Studio, a workspace package with its own spec, checked by `pnpm --filter vibestack-studio check`: change `spec/`, then its shell in `src/`. Under `pnpm dev`, its `dev` script waits for what its build does, Studio's `gen` and the packages it builds on, then rebuilds the page it serves on each save of the page's sources, and builds afresh when the Vite config, `vibestack/design` or the tokens change: reload the browser, no restart |
| `vibestack/prove.ts` | proves one unit: checks and splices the proof file, runs LemmaScript and `dafny audit`, verifies again with every assertion isolated each definition that fails, and alone every postcondition a failing one could hide |
| `vibestack/proof/lib.dfy` | the library proof files call |
| `vibestack/std/` | specs that ship with the tools, which any spec may import, each with its proof file |
| `vibestack/conform.ts` | the `traces` stage: drivers, each in a Node of its own, `driver:` programs and recorded traces; saved counterexamples; the driver stub |
| `vibestack/explore.ts` | the `explore` stage: serves a package's page with its app script, runs Bombadil on it, and replays and removes a saved run |
| `vibestack/conformance.ts` | the comparing: journeys, malformed-input probes, walks, shrinking and replay; copied into `gen/` for a driver's types |
| `vibestack/testing/` | what packages import: `project()` (the Vitest configuration), the property-test generator, `effectDriver` |
| `vibestack/stories/`, `vibestack/design/` | generated stories and their tests; design tokens and their lint rules. The design project module in [`vibestack/design/project.ts`](vibestack/design/project.ts) builds or checks several token directories in one process. |
| `vibestack/eslint.ts` | `withWorkspaceBarrels`: ESLint rules enforcing barrel-only workspace `exports` and imports, with per-file ratchets |
| `vibestack/gen.ts` | the translator: reads what a module imports and defines |
| `vibestack/gen/types.ts` | everything decided by a type |
| `vibestack/gen/print.ts` | expressions |
| `vibestack/gen/classify.ts` | which definition is a transition, a guard or a rule |
| `vibestack/gen/secrecy.ts` | where a secret may go |
| `vibestack/gen/typescript.ts`, `vibestack/gen/harness.ts` | `gen/<name>.ts`, and the Quint module `gen/<name>.run.qnt` that simulation runs |
| `vibestack/selftest.ts`, `vibestack/fixtures/` | the tool selftest and the specs it uses besides the order example |
| `vibestack/selftests/` | the docs and standalone example selftests, and helpers used by the selftests |

Node runs all of it directly; `pnpm build` compiles it for the packaged `spec` command.

`check(root)` returns `{ ok, results, next }`, and `spec check --json` prints each result as one line of JSON as soon as
it is reported, then that object as its last line. Each result has `ok`, `stage` (a stage, or `skipped`), `summary`,
`detail` and, when it concerns them, `where` and `rules` (each rule as `{ file, key }`); `next` is the line the command
line ends with. `pnpm selftest` builds scratch projects from this project's spec or from `vibestack/fixtures/`, breaks
one thing at a time and asserts which stage catches each. It runs as five cached tasks, each keyed by what its tests
read: `selftest:docs` the documents against every file they can name, `selftest:examples` each standalone example
against its own files and the tools. `selftest:tools:a` and `selftest:tools:b` build scratch projects from the order
example and fixtures. `selftest:tools:rest` also rebuilds the packaged CLI from the workspace, so app manifest changes and changes under
`packages/` or `spec/` invalidate its isolated CI run. The first two each run one shard of the kinds of mistake, the
`describe` named `in shard a` or `in shard b` in `vibestack/selftest.ts`. The third runs the remaining tool tests there.
Changes to either docs or standalone example test code keep the tool shards cached. Keep the longest tests spread over the three.
Changes to the root README rerun the docs and packaged tool checks.
The two suites of the tools, the command line and each kind of mistake, run side by side under one parent, each at most four tests at a time. The order project the
edits copy and a few long checks of fixtures are shared projects: each starts with the tool runs (`action-*` entries)
earlier selftests kept in `.cache/selftest/.spec-cache` and leaves its own there; entries unused for a week are pruned.
A test that observes a tool really running uses a scratch project of its own, which starts empty.
Scratch dependency installs clone package files when the filesystem supports it and copy them otherwise. Both methods leave the shared store's hardlink metadata stable while parallel checks observe an installed verifier.
`pnpm selftest` runs all five through Turborepo, side by side, as `pnpm verify` does. Each of the three
`selftest:tools` processes bounds its own tests and tools to the machine and checks the order project once for itself,
so three at once ask about three times what one does: on a machine too small for that,
`pnpm selftest --concurrency=1` runs one shard at a time. What a change to the
tools owes it, and the sync skill, is in [AGENTS.md, "Definition of done"](AGENTS.md#definition-of-done).

For phase timings, subscribe to the Node diagnostics channel `vibestack:check:phase` before running `spec check`.
Each message has `root`, `checkStartedAt` (Unix milliseconds), `phase`, `event` (`start` or `end`) and
`elapsedMs` (milliseconds measured by a monotonic clock since the check acquired its project lock). Phases
can overlap. The simulation end records when the last simulation settled. Its message can arrive later,
once generation has scheduled every simulation. An ordinary exception closes open phases as the check
unwinds. If the process is interrupted, only events already delivered are available. The check's results
and exit code still come from its normal output. Keep subscribers' output outside the project and catch
errors in subscribers, since Node reports a thrown subscriber error as an uncaught exception.

## Releasing

Set `version` in the root `package.json`, merge to the default branch, and push the tag `vibestack-v<version>` from it.
`.github/workflows/release.yml` builds, packs with `pnpm pack`, materializes the shard prerequisites and runs `pnpm selftest --only --concurrency=1` using the same keys as CI, and attaches the tarball to a GitHub release of that tag.
A project installs it as [the Vibestack guide, "Using it from another package"](vibestack/README.md#using-it-from-another-package) says.
## Architecture

The spec owns the rules and state; generated code is its runtime contract.
Pure logic Quint cannot express lives in `src/**/*.ts` with proved `//@`
contracts. VibeLang owns effects and I/O; React reads the generated `Machine`
service through hooks. Persisted data enters through `decodeState` or a
schema, never by trusting stored JSON. Controls follow `enabled`, and the
shell applies events through `Machine` or the generated Effect adapter.

### Sources and generated files

Every root spec module is generated into the root's `gen/`. A workspace
receives the modules it owns and their imports in its own `gen/`. The root
`package.json` maps plugin spec areas to their `plugin-*` workspace directories
through `specOwners`. Packages import their own generated files.
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
`gen/` untouched, so nothing that watches them rebuilds. Whole-tree `spec gen`
keeps the generated files in memory until every model is valid, then updates
changed files. An invalid edit leaves the existing outputs in use. A check loads
each generated module from its own `.spec-cache/run-<number>/`, removed when it ends. The first check in a new
process uses the same path so Node can reuse compiled modules. `.spec-cache/`
remembers each run of Quint (which parses and typechecks a harness once for all its simulations, each run by Quint's
evaluator on the result: `vibestack/simulator.ts`), and of LemmaScript and Dafny on a proof, under the program as installed, its arguments and
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
remembers under the programs installed now. Each tool runs in a process group
of its own, and a check that is interrupted, or that exits, ends each group
still running and the group of each process a tool started outside its own, as
a browser is: no verifier, simulation or browser outlives it. A tool stopped
for its time or its output is ended the same way. An unreached simulation goal
or an event its guard never allows cancels the queued proofs started alongside
the simulations. On systems with process groups, it also stops their running
tools. The check reports every simulation and waits for the tools to close
before it releases the project lock. A run
of a tool is remembered when it reached its answer, a refusal of its input
included, never when it was stopped, timed out or failed for want of a file or
program: an unchanged unit whose proof failed runs neither again, and an edit
to a proof file only checks and verifies the Dafny it changes. When several proof units import
the same module, the check renders that module once for each name prefix and citation setting they use.
A unit offered
what the units it imports proved is proved once when their results are
remembered, and meanwhile, to be proved again if they fail, only while one of
them is still being proved. The first attempt starts no further checks of failed
assertions once a finished import removes one of its assumptions. A test run
may run any tool, as Studio's do, so it is keyed by all of them, and with a
typecheck, a driver's run and an exploration by VibeLang's version and bytes.
An exploration is keyed by the code that explores and what its page reads
(`pageInputs` in `vibestack/explore.ts`), which holds every tool when the
page runs one, as Studio's does.
Vitest stores transformed test modules per package. That package's installed
lockfile controls when its transforms are cleared.

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
loads the pipeline, and hands its directory to every process a check starts,
so each `spec` process, Studio's checks, Turborepo's tasks and the tests and
drivers they run included, compiles only the code that changed.

An integration checking disposable project directories can import `check`
and `withFormalCache` from [vibestack/formal](vibestack/formal.ts). Run
`await withFormalCache(cacheDirectory, () => check(projectDirectory))`
in the same Node process. Use a persistent cache directory writable only
by trusted runs. It holds
the completed Quint, LemmaScript, and Dafny actions, keyed by the installed
tools and their inputs. The project directory holds its lock, generated files,
and stage results. An acceptance or nightly check always reads fresh inputs.

To precompute normal-profile simulations for a subset of a disposable project,
use `precomputeSimulations(projectDirectory, readSpecs(projectDirectory), moduleNames)`
from the same entry point inside `withFormalCache`. It compiles the selected
modules and their transitive imports, runs the selected simulations and replay,
and returns their verdicts in the requested module order. Treat a failed verdict
or rejection as a failed precomputation. Run the full check with the shared
actions to verify the whole project.

For a transfer between trusted runners, call `prepareSimulationReceipts` with
the same three arguments and an existing private scratch directory as the
fourth. It returns `results` and, when all requested simulations passed and
their receipts are complete, `seedDirectory`. Otherwise `partialDirectory`
can hold the certified model typechecks and simulation results available from
the run, including reproducible failures. Transfer only the files in the
returned directory. Copy them into the receiving project's `.spec-cache`
before the full normal check and keep them within the same trust boundary as
other spec cache entries. The check computes its own keys and recomputes a
missing or unreadable result.

Turborepo caches `gen`, `build`, `typecheck`, tests, selftest and lint according
to `turbo.json`. When a legacy generation config excludes proof paths, the
task entry point includes the spec ownership layout and any Markdown under
those proof-named directories in the generation key. Dependent task keys
follow these changes. The task entry point fingerprints Node, VibeLang, Dafny, Z3
and their runtime files before Turbo hashes its inputs. A build can run
without the verifier. Its task key records missing verification tools,
and a proof still requires them. What it reads of an
installed file, and Dafny's version, is remembered across processes in
`$XDG_CACHE_HOME/vibestack` (`~/.cache/vibestack` by default) while the file's
device, inode, size and modification and change times stay the same, so an
unchanged toolchain is not read again, nor Z3 asked its version. A check
reads those times of Dafny's installation once, and reads them again after each
run of Dafny, so a result is not remembered when the verifier was installed
again during the run. The template install generates locally with `gen --if-valid`.
The install command runs its listed root prerequisite tasks together before generation.
The three tool selftest jobs in `ci.yml` run only the listed `//#build` task and generate their scratch
projects on demand. The packaged CLI test rebuilds from a clean copy of the
workspace. The nightly check builds the tools during install and generates the
application in its nightly task graph. Other GitHub Actions jobs use the same strict root
`gen` task as verification, so a successful install warms the task cache. A failed generation leaves the
remaining checks runnable and is retried by verification. Generated stories,
browser build artifacts, compiler declarations and successful test receipts
are restored with their owning task. `check` is never skipped whole: its
`driver:` programs run the real application in `traces` every time. Standalone examples install and check separately. The selftest keeps a complete passing run for each example
under its own inputs and the shared toolchain and sources. After an edit to one example, the other examples
can reuse their passing runs. Use `pnpm selftest:examples` to run every install and check directly.

A complete passing Vitest run records its input fingerprint. `check` reuses
that result only while its source, generated core, transitive workspace
inputs, lockfile and fixed profile match. The fingerprint covers the package's
files, with the packages nested under its `test/` as fixtures but not other
nested packages, and of each `workspace:` dependency what a dependent can
load: not its `spec/`, Markdown outside `fixtures/`, tests, drivers, traces,
counterexamples or nested packages, nor its `gen/` unless its code or manifest reaches into it; a
file a test reads from elsewhere comes through a declared dependency, as the
root's `@repo/design-system` does. A typecheck is keyed by the scripts and
JSON alone, and then by the content of every file the compile read. Neither
covers the simulations' traces in `gen/traces/`, which no test reads and a
check rewrites, nor the prose `spec init` and the tools keep at a package's
top (`README.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `SPEC.md`). Turbo's
`//#test` inputs cover the same files but the root's Markdown, so a restored
receipt matches unless another root document changed, and then `check` runs the
root's tests itself. Generated code names each rule by its heading, not its line, so
prose that only moves a rule changes none of these keys. Filtered, exclusive, interrupted
and failed runs record no complete result. Acceptance and nightly checks
bypass these receipts and the inner verification cache. A package that declares a `link:`
dependency, or reaches one through a workspace dependency, runs its inner tests, typecheck and
drivers afresh. The linked checkout can supply compiled files and resources outside the
consumer's lockfile. Its project's Turbo tasks can cache those commands when they declare
the external inputs and outputs they use.

The spec cache retains recent branch and profile results for 30 days within
256 MiB, evicting the oldest unused results first. A check's own entries are
preserved. Proof identity covers the verifier and solver contents, so moving
an identical installation does not invalidate it and replacing an executable
with the same version does; tests, drivers and explorations are keyed by the
verifier too, since they may run proofs, as Studio's do. A process that
outlives a reinstall, as `spec watch` does, reads the installed toolchain
again on the next check. Simulations and proofs include the resolved package files
and dependency links for Quint and LemmaScript. Each check shares an installation
inventory across runs of the same tool and validates its files before publishing a batch.
Recognized stock pnpm POSIX tools run in private copies of their declared package
closure with the selected Node interpreter and no ambient module search. The
simulator uses the tool-local Quint copy, which may differ from the CLI version.
Source and private files are checked before publication. Custom launchers, Windows
shims and Node preload options retain ordinary execution without receipt reuse.
The first action, long actions, completed stages and the end of the check flush pending results.
If a concurrent installation changes these files, the check discards the pending results
and retries under the same project lock. It stops after two unsuccessful retries. A
simulation also depends on the bytes of Quint's installed Rust evaluator. A
run that installs its evaluator can produce a result; the next run records it
against the installed binary. The task runner supplies the evaluator fingerprint
to simulation-capable tests and selftests, leaving generation, builds and
typechecks reusable before and after installation. Turbo passes `QUINT_HOME`
to tasks so they use the selected evaluator. Its bytes determine the fingerprint.
In CI, a Turborepo cache entry is
kept for seven days after its last hit, which the run summary names.

The shared Dafny library is a direct input of the tool package build and the
Studio tests that run proofs. An edit to that library leaves the application
build keys unchanged.

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
`check` enforces. The examples under `vibestack/examples/` demonstrate each kind.

| Kind | Checks | Source or example |
|---|---|---|
| Formal | Rules and laws for every state and input | `spec/`; `.proof.dfy` where Dafny needs help, such as `spec/core/actionPlanning.proof.dfy` and `vibestack/fixtures/highest.proof.dfy` |
| Model-based | Real shell against the spec: journeys, malformed input, walks and saved counterexamples | `test/drivers/app.ts` and the recorded `test/traces/app.jsonl`, run by `traces` |
| Journey/integration | A story through real services, including what a driver cannot see | `@effect/vitest` in `test/app.test.vibe`: reload from storage |
| Component/browser | Story interactions and accessibility; browser-only behavior such as focus and storage | Component metadata `play`; `test/app.browser.test.tsx` in Chromium |
| Exploratory/browser | The served page under random clicks, typing, scrolling and reloads: no uncaught error, console error or failed request, and the properties each rule gives the page, in every state reached | `test/bombadil.ts`, or nothing for Bombadil's defaults; `vibestack/examples/fullstack/test/bombadil.ts`, run by `explore` |
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

ESLint enforces workspace barrel exports (`barrel/exports` on workspace
`package.json` manifests, including `publishConfig.exports`, and
`barrel/no-subpath-imports` on code files, via `withWorkspaceBarrels` in
`vibestack/eslint.ts` with `allowExports` / `allowImports` ratchets for
adopting repositories) and the stack boundaries, and in `packages/` the code rules of AGENTS.md, "Writing code": no comment but a spec
citation or tool directive, no effect hook, timer or `console`, and no inline
config but a reasoned `eslint-disable` of another rule. `commented` and
`scheduled` in `eslint.config.js` give each file that still breaks them the
count it may keep; one more fails, and cleaning a file lowers or deletes its
entry. Eliza's native logger bridge keeps its three existing console accesses
under the same count limit, enforced by the built-in diagnostics; new files
and any increase fail. Knip finds unused
files, exports and dependencies, reading `.vibe` and `.vibex` through VibeLang's
compiler. Madge checks cycles in `.ts` and `.tsx` imports. jscpd fails on any
duplicated block of code outside the examples and test fixtures. Their
configured scopes are in `knip.config.js`, `.madgerc`, `.jscpd.json` and
`eslint.config.js`.

### CI

| When | Runs |
|---|---|
| Pull request or push to `vibestack`, `develop` or `main` | The tasks of `pnpm verify`, with up to four concurrent Turbo tasks on the hosted runner and `--continue=dependencies-successful`, over eight jobs, beside the Android Node lock check: `simulate-1` to `simulate-4` each simulate the specs assigned by file hash, starting from the spec cache `verify` saved. A shard fills missing receipts from an earlier run of its layout and lockfile. When native simulation starts on a pull request, waiting models can also reuse the validated archive from the push to its exact base commit. An unavailable archive leaves the ordinary computation running. When it creates simulation aggregates, it saves its certified typechecks and simulation results for later runs, including reproducible failures. A visible immutable cache with the same content fingerprint avoids a duplicate save after a late transfer. It transfers the available receipts to verification and reports failures. When the shards finish, `verify` keeps its restored receipts, imports missing keys on which the shards agree, computes the rest, and runs build, types, tests, browser tests, all checks, ESLint, Stylelint, Knip, Madge, jscpd and the selftest of the documents and the examples; beside them all, `selftest-a`, `selftest-b` and `selftest-rest` each run one `selftest:tools` task |
| Nightly | Every check fresh under the fixed nightly profile; saved counterexamples become a pull request into the branch the run checked, or the default branch for a tag run. Beside it, the three `selftest:tools` tasks without the selftest's shared tool runs |
| A `vibestack-v*` tag (`release.yml`) | Build, `pnpm pack`, the prerequisites and `pnpm selftest --only --concurrency=1`, and the tarball attached to a GitHub release |

In the canonical `ci.yml` workspace, simulation precompute installs the root
tool workspace’s production dependencies when its prepare script matches the
standard tool preparation. Verification owns application builds and generation.
Other workflows and custom prepares retain the full frozen install.

This repository runs its six root specs in the ordinary check. Consumer
workflows using the four simulation jobs assign modules by file hash. Each
shard can fill gaps in its restored spec cache from a previous run of the same
shard layout and lockfile. When a pull request starts native simulations, it
can also read that shard’s published receipts from the push to its exact base
commit while ordinary verification runs. Queued models can reuse receipts
that arrive before they start. A missing or unavailable archive leaves the
ordinary computation running. When the shard produces new simulation
aggregates, it saves its certified snapshot for later runs, even if a rule
failed. A late import only needs another save when its final snapshot has
no visible cache with the same content fingerprint. It also
transfers the available receipts to the ordinary check and reports failures.
The check keeps its restored receipts, imports missing keys on which the shards
agree, and computes the rest.

In the canonical `ci.yml` workspace, simulation precompute installs the root
tool workspace's production dependencies. The root prepare script leaves
application builds and generation to verification.

Each row's budget is in [Seeds and budgets](#seeds-and-budgets). A failing
run keeps `test/counterexamples/` and `test/__traces__/`, where a broken
exploration is, as an artifact.
The run summary lists Turbo task times, cache status and exit codes.

Each run installs Dafny from its pinned release, checked against its SHA-256,
and restores pnpm's store, Quint's evaluator, and what the job adds to: a `selftest-*` job the selftest's shared
tool runs, any other the spec cache of the root, each workspace package and each example. The key is of the job, the
lockfile and the commit. A job tries both key layouts for its own name and current lockfile, then tries the current
layout for another lockfile. Selftest jobs on pull requests first try an archive for that pull request and lockfile.
A successful replay of the entire fixture task can reuse that archive when setup leaves the cached evaluator intact.
Fixture jobs restore their pull request’s Turbo archive before the shared fallback. A full replay keeps that archive when the cached files stay unchanged and no files need pruning. Turbo refreshes its checkout-specific restore manifests locally.
Each entry is named by the tools and inputs that produced it, so a job reads only the entries that still apply.
Nightly jobs restore the pinned Quint evaluator and run with fresh verification
results.
The default branch's `verify` job publishes the pnpm store after the frozen
install. All jobs can restore it by the same lockfile key. This cache holds
public packages only because fork pull requests can read it.
CI verification installs the headless shell for Playwright. An exploration or replay that runs Bombadil installs full Chromium on first use. Hosted shard A installs full Chromium when its Bombadil journey runs. Nightly shard A and release install their required browsers during setup. The other tool shards run without a browser.
CI sets `TURBO_CACHE=local:rw` and restores each job's Turbo task results from GitHub's cache, only those a job
of the same name saved.
Branch pushes save results that later pushes and pull requests can restore. A pull request's
own saves are scoped to that pull request. Newer commits replace an older run of the same pull
request. Pushes to one branch run one at a time. A run that has started
finishes and saves its caches, and the newest pushed commit replaces any run
still waiting. Re-run a specific commit when you need the results for that
revision; a re-run starts at once.
The task entry point disables Turbo telemetry. Local `selftest:tools` tasks wait for the
root and Studio tests. In CI, the verify job runs those integration tests once.
Each dedicated shard uses Turbo's `--only` after setup builds the toolchain.
Fixture selftests on a pull request first restore an archive scoped to its PR number and lockfile. A complete cached task reuses it only when setup preserves its evaluator; inherited archives, evaluator changes and actual fixture execution retain normal publication.
Fixture jobs restore their pull request’s Turbo archive before the shared fallback. A full replay keeps that archive when the cached files stay unchanged and no files need pruning. Turbo refreshes its checkout-specific restore manifests locally.

The canonical nightly install builds the tools and defers application generation to its nightly task graph.

All three tool shards skip workspace generation. The two fixture shards use their scratch inputs, and the packaged CLI test builds its workspace copy.
Release materializes the prerequisites before running the isolated shards.
Packing the Vibestack CLI builds the toolchain and Studio. The package's
prepare script uses `--skip-gen-on-pack` to skip Eliza application generation because
the tool archive does not include those generated files.
Local `pnpm` task commands read the operator's cache credential from
`~/.config/vibestack/turbo-cache.json`, outside the repository. Credentials
are never part of a task fingerprint.

The standalone examples are the tools' own subjects: `pnpm selftest` installs
each from its own lock file and runs its `check`, its page explored where it
has one. An application built on the tools never checks them: its `check`
reaches only its own packages, and the packed toolchain carries no example.
