# Operating procedure for agents

Each application starts at `spec/index.md`: its stories, rules and Quint
model, with links to child specs wherever an area needs its own directory.
`gen/` is derived from it. Keep the spec true to what the user wants and
`pnpm check` green.

**Read this file in full before doing any work.**
The spec format, naming rules and everything the tools accept are in
[SPEC.md](SPEC.md); what a task needs beyond it is in
[Where the rest is](#where-the-rest-is).

## Loading skills

The canonical skills are in `.claude/skills/`: `sync`, `shell`, `prove` and
`design`. Claude Code discovers them there; Codex discovers the same files
through the relative links in `.agents/skills/`. Edit the canonical files,
and give each new skill a matching link so both clients see it.

A skill's name and description are only its discovery metadata. Before
the work listed in [Where the rest is](#where-the-rest-is), read the matching
`SKILL.md` in full and follow its relevant linked references. In ChatGPT or
another client without repository skill discovery, open those files
explicitly. Resolve repository paths from the repository root and a skill's
relative links from its own directory. If the client cannot read repository
files, ask for the relevant instructions before doing that work.

## Who does what

`pnpm check` detects; you translate: story → rules, rule → Quint, changed
Quint → prose, counterexample → rule. That is your work in this session; it
needs no other program or account.

**Whenever `spec/` or `src/` has changed, follow
[.claude/skills/sync/SKILL.md](.claude/skills/sync/SKILL.md)**: the loop, what
each failure asks of you, and what to report. Read the skill before following
its loop.

The user signs off with `pnpm accept`.

## The stack

Every project built here uses this, and nothing beside it:

| For | Use | Never |
|---|---|---|
| Runtime | Node 26 | an older Node |
| Packages | pnpm workspaces, pinned by `packageManager`; Turborepo runs and caches tasks across them ([SPEC.md](SPEC.md#one-spec-tree)) | npm, yarn, bun; a second task runner |
| Rules and state | the spec, and the code `gen/` derives from it | a second model of the same state |
| Shell: effects, services, I/O, async | [VibeLang](.claude/skills/shell/SKILL.md) (`.vibe`) on Effect 4 | plain TypeScript for effectful code; Redux, Zustand or another state library |
| User interface | React, in `.tsx`, built with Vite | Vue, Svelte, Angular, hand-built DOM |
| UI state | React hooks over the generated machine's `Machine` service | state kept in a component that the spec owns |
| Styling | Tailwind CSS v4 with the project's design tokens, shadcn/ui conventions on Radix primitives | hard-coded colors, a second token set, global CSS beyond the token file |
| Tests | Vitest with `@effect/vitest`, on `test/**/*.test.{vibe,tsx}`; a driver for a shell that keeps a machine's state | Jest, `node --test` for a new test |

- **Every interface is React**: an application's, an example's and Studio's.
- **Reuse before adding.** Find the component, token or service that exists
  and extend it; add one only when none fits.
- **TypeScript stays** for `gen/`, for verified `//@` logic
  ([prove skill](.claude/skills/prove/SKILL.md)), for React components and for the tools.

## Where the rest is

Read each before the work it covers, whether loaded as a skill or opened
directly.

| Read | Before |
|---|---|
| [SPEC.md](SPEC.md) | writing or reading a spec: its format, the Quint it accepts, the generated code, review and conformance |
| [`sync` skill](.claude/skills/sync/SKILL.md) | any change to `spec/` or `src/`, and whenever `pnpm check` shows a `✗` |
| [`shell` skill](.claude/skills/shell/SKILL.md) | writing `src/` or a test: VibeLang, the Effect adapter, the React interface, building and running |
| [`prove` skill](.claude/skills/prove/SKILL.md) | a `proof` stage `✗`, writing a `.proof.dfy`, or a `//@` file |
| [`design` skill](.claude/skills/design/SKILL.md) | anything a person looks at: layout, components, stories and tokens |
| [CONTRIBUTING.md](CONTRIBUTING.md) | generated files, tests, caching and CI; adding a package or task, or changing the tools under `vibestack/` |
| [README.md](README.md#commands) | the commands, Studio, and [using the tools from another package](README.md#using-it-from-another-package) |

## Hard rules

- Never edit `gen/`, `.spec-cache/`, `.studio/` or `spec/lock.json`, and never add a
  `lemmascript.json`. The tools own them; a change there could make a check
  pass that should not.
- Never run `pnpm accept unproved` unless the user asks. It lowers the
  listed obligations from proved to simulated.
- Run `pnpm accept` only when the user asks, and only after reading each
  rule `review` lists and finding that its prose and Quint say the same thing.
- Never weaken or delete a rule (`always`, `step`, `sometimes`, `leadsTo` or `law`) to
  make a check pass without telling the user which rule and why.
- Proving obligations is your work, in `spec/<path>.proof.dfy` or
  `src/<path>.proof.dfy` ([prove skill](.claude/skills/prove/SKILL.md)). Satisfy a check;
  never get past it: no trust or skip annotations, no edits to the tools or
  what they generate, no workaround for what a proof file may not contain.
- Verified logic belongs in the spec as `pure def`. Hand-write code in `src/`
  only for what Quint cannot express (TypeScript with proved `//@` contracts)
  or what touches the outside world (VibeLang, and React for what a person
  sees).
- Never work around the stack above: no other package manager, UI framework,
  state library or test runner, and no effectful shell code outside VibeLang.

## Writing code

Check each point before you write, and again after.

- **Design.** Anything a person looks at follows
  [.claude/skills/design/SKILL.md](.claude/skills/design/SKILL.md).
- **One path.** Replace old code; do not keep it beside its replacement. No
  feature flags, environment variables or settings for a change.
- **Reuse.** Search for existing code and types first. Extend and share; no
  duplicates or one-offs.
- **Compact.** Reread for needless branches, `try` blocks, wrappers and
  indirection. Shorter, if it reads as well.
- **Comments** point to related code or to the spec rule a line serves. Never
  describe what changed or was added.
- **Scripts and tests.** Extend existing ones before adding; no new scripts.
  Delete code that becomes unused. Tests follow "Tests" below.
- **Speed.** Keep checks and CI fast: a small change reruns only what it
  touches; a full run is as quick as it can be.
- **Passes.** The first version is a draft. Review it two or three times
  against these points.

## Tests

The spec proves the rules for every state and input; a test covers only what
`pnpm check`'s other stages cannot see: hand-written code meeting the
outside world. Write one only when its failure would be a bug a user meets
and nothing else would catch it.

| Earns a test | Never a test |
|---|---|
| A whole user journey, or an integration with a real service, through the real shell: input parsing, storage, HTTP, UI wiring | A guard, transition, rule or law the spec already proves, except as a step of a journey |
| Hand-written code that touches the outside world, through the journey that uses it. Pure logic becomes a `pure def` or gets a `//@` contract instead | Strings, labels, page titles, markup, styles, snapshots and screenshots: no test compares pictures |
| A shell bug that was found: one more step in the journey it broke | That a function was called; what the `types` stage already checks |

- **Journeys.** A test walks a story end to end, is named after it, and cites
  the rule each assertion serves (`// spec/index.md, "…"`). A story whose
  path never leaves the verified core needs none.
- **Real services.** Run the real database, server, queue and filesystem,
  started and reset by the `test` script or the runner's setup: an in-process
  database such as PGlite, a container, a local emulator, a provider's test
  mode. Fake only a service that costs money, cannot
  be undone, or cannot be run and reset locally; fake it once, at its network
  boundary, shared by every test. No mocks of your own code.
- **Search, then extend before adding.** Search the tests for the citation of
  the story or rule first, and extend the journey that has it: a step or
  assertion in an existing journey before a new test; a new test before a new
  file. A test that repeats another's setup to assert one more thing belongs
  inside it.
- **Compact.** Shared helpers over repeated setup, one assertion of a whole
  value over one per field, no comment that restates the test's name.
- **One command.** `pnpm check` runs the package's `test` script, which
  runs the tests and never the package's own check (a tool's journeys may check
  scratch projects, as Studio's do). No other test scripts, and nothing a
  person must set to run them; the config a runner or service needs is fine.
- **Size.** One file per package and runner is the norm, and 5,000 lines is fine. At
  15,000 lines, consolidate and simplify; split only at 20,000.
- **Never weaken a test to pass.** Fix the code. If the spec now asks for
  something else, change the assertion and name it and its rule in your
  report. Propose deleting a test; never delete one yourself.

How `pnpm check` runs them, in its `tests` stage:

- **The run.** It runs the package's `test` script in the package's directory,
  with the package manager `packageManager` or the nearest lock file names.
  The exit code decides; a failure shows the runner's list of failures, at
  most 200 lines of it. A pass is remembered until something the tests read
  changes, and a complete passing Vitest run records a receipt that lets `check`
  reuse the same result. Filtered or failed runs supply no receipt; acceptance
  and nightly checks always run afresh.
- **One configuration.** The `test` script is `vitest run`, on
  `project({ root: import.meta.dirname })` from `vibestack/testing/vitest`, as
  `spec init` writes it; a package with `test/` and no `test` script gets
  both from `check`. It runs `test/**/*.test.{ts,tsx,vibe}` in Node (a test
  that needs a DOM says `// @vitest-environment happy-dom`), and
  `*.browser.test.*` in Chromium, by `vitest run --project browser` (the
  `test:browser` script). Before each run it writes the
  [generated property tests](CONTRIBUTING.md#which-test-for-what) of
  every `src/**/*.schema.*` and `src/**/*.contract.*`; a module that yields
  none fails the run, with why. A package with no tests passes.
- **Citations.** A test, or a shell file in `src/`, in VibeLang or
  TypeScript, names the story or rule it serves by its heading, on one line:
  `// spec/index.md, "A payment never exceeds the balance"`, or
  `// spec/index.md, "Story: Check out"` for a story; several may share a line,
  separated by `;`. The path is the spec's from the root of the spec tree,
  in an owner's code too: `// spec/app/index.md, "…"`. Each `it` or `test`
  needs one: on its line or in it, on the `describe` or layer around it, or
  in the file's header. `check` fails on an uncited test, and on a citation
  whose heading the spec no longer has, so a renamed or removed rule brings
  its tests up for review; `review` lists the code that cites a changed rule.
- **Past the generated code.** A test that reaches nothing but `gen/` and
  test libraries, through the helpers of its own file, fails: it restates
  what the spec proves. Route it through `src/`, or propose deleting it.
- **Drivers are not tests.** `test/drivers/` is run by the `traces` stage
  ([SPEC.md, Conformance](SPEC.md#conformance)), and imports `gen/` as types only; `check`
  fails on a driver that imports its code.
- **Notes**, never failures: two test files for one runner and language, a
  test file of 15,000 lines, and a spec of the package that no test cites and
  no driver, trace or `driver:` script checks.
- **Monorepos.** The root's `check` runs the tests of the root and of each
  owner (SPEC.md, "One spec tree"), each in its own directory; a package with its own
  `spec/` runs its own `check` and tests (`pnpm test:models` for all;
  `pnpm --filter <name> check` for one). A test cannot start a check of the
  project that is running it. A journey that crosses packages is tested in
  the package that owns it, usually the app.

## Definition of done

- `pnpm check` is where step 3 of the sync skill's loop stops: what is
  left waits on the user.
- In the vibestack repository, if you changed `vibestack/`, `pnpm selftest`
  passes, with a new case for each new kind of mistake the change catches,
  and each new kind of `✗` has its row in the sync skill.
- What you wrote has had its passes under "Writing code".
- Your summary follows "When you stop" in the sync skill.
