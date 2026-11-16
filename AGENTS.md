# Operating procedure for agents

Each application starts at `spec/index.md`: its stories, rules and Quint
model, with links to child specs wherever an area needs its own directory.
`gen/` is derived from it. Keep the spec true to what the user wants and
`pnpm check` green.

**Read this file in full before doing any work.**
The spec format, naming rules and everything the tools accept are in
[SPEC.md](SPEC.md); what a task needs beyond it is in
[Where the rest is](#where-the-rest-is).

## Working on a task

- **Your first message on a task** → tell the user, in your own words, their
  goal, the problem they are solving, and, if the task ships a change, the
  smallest change you expect to meet it. Don't wait for confirmation. If the
  evidence rules out the change the user asked for, show it and stop. Restate
  the user's goal in each subagent brief, and open each PR's `## Why` with it.
  Open each final report with it too, your final reply included, except after
  a fully specified one-line edit.
- **Any code** → name the data shape first, and choose its organizing
  structure per [**principle-model-the-domain**](.claude/skills/principle-model-the-domain/SKILL.md).
- **Code crossing a function boundary** → the
  [**architect** skill](.claude/skills/architect/SKILL.md), parallel design
  exploration before implementing.
- **Just do it.** Use any available MCP tool within its permissions. Reversible
  work and authorized external actions (team chat, ticket updates, kicking off
  evals) proceed without asking for confirmation.
- **Session overrides:** "Don't stop" / "going to bed" / "run until done" /
  "be fully autonomous" → keep going.
- **No is an acceptable answer.** Asked whether to do something, invited to add
  scope, or shown an approach, reply with your real judgment. Decline, push
  back, or say "this doesn't earn its place" when true. A recommendation is a
  judgment, not a validation. Agreement is not the default, candor over
  sycophancy.

## Loading skills

The canonical skill files are in `.claude/skills/`, including `sync`,
`shell`, `prove`, `design`, `architect` and the [principles](#principles).
Claude Code reads them there. The shared `.agents/skills/` directory has one
relative link per skill for agents such as Codex. Edit the canonical files
and run `pnpm install` or `spec init` to create missing links in the project.

A skill's name and description are only its discovery metadata. Before
the work listed in [Where the rest is](#where-the-rest-is), read the matching
`SKILL.md` in full and follow its relevant linked references. In ChatGPT or
another client without repository skill discovery, open those files
explicitly. Resolve repository paths from the repository root and a skill's
relative links from its own directory. If the client cannot read repository
files, ask for the relevant instructions before doing that work.

Apply imported skills within this repository's stack, hard rules and test policy.

Architect uses [`arena`](.claude/skills/arena/SKILL.md) for parallel design
exploration and [`why`](.claude/skills/why/SKILL.md) to trace the rationale
for existing ownership or layering when a design changes it. If the client
cannot run Arena's runners, use its parallel subagents for at least two
independent design sketches with the architect's
[`runner-prompt.md`](.claude/skills/architect/references/runner-prompt.md).
Screen and synthesize the sketches as the architect skill directs before
implementing.

Use [`benchmark-checklist`](.claude/skills/benchmark-checklist/SKILL.md)
when measuring performance. For other referenced skills, see the
[upstream pstack skills at the imported revision](https://github.com/cursor/plugins/tree/bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7/pstack/skills).

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
directly. The last two are the vibestack repository's; a project that
installed the tools has `README.md` in `node_modules/vibestack/`.

| Read | Before |
|---|---|
| [SPEC.md](SPEC.md) | writing or reading a spec: its format, the Quint it accepts, the generated code, review and conformance |
| [`sync` skill](.claude/skills/sync/SKILL.md) | any change to `spec/` or `src/`, and whenever `pnpm check` shows a `✗` |
| [`shell` skill](.claude/skills/shell/SKILL.md) | writing `src/` or a test: VibeLang, the Effect adapter, the React interface, building and running |
| [`prove` skill](.claude/skills/prove/SKILL.md) | a `proof` stage `✗`, writing a `.proof.dfy`, or a `//@` file |
| [`design` skill](.claude/skills/design/SKILL.md) | anything a person looks at: layout, components, stories and tokens |
| [CONTRIBUTING.md](CONTRIBUTING.md) | generated files, tests, caching and CI; adding a package or task, or changing the tools under `vibestack/` |
| [Toolchain guide](vibestack/README.md#commands) | the commands, Studio, and [using the tools from another package](vibestack/README.md#using-it-from-another-package) |

## Hard rules

- Never create new Markdown documents. Update the existing rules and spec as
  needed so guidance stays in one place and does not go stale.
- Always avoid `useEffect`, `setTimeout`, and similar workarounds. Keep shared
  application state in the spec-backed `Machine` service.
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
- **Fix the root cause.** Investigate before making a fix. Trace the problem
  to its source and fix it there. Avoid patches that only hide symptoms.

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
- **No code comments.** Use clear names and structure to make the code readable.
  Use comment syntax only for required tool directives that need it, such as
  `//@` contracts and Vitest environment directives.
- **Scripts and tests.** Extend existing ones before adding; no new scripts.
  Delete code that becomes unused. Tests follow "Tests" below.
- **Speed.** Keep checks and CI fast: a small change reruns only what it
  touches; a full run is as quick as it can be.
- **Passes.** The first version is a draft. Review it two or three times
  against these points.

## Principles

Read the leaf skill in full for any principle you apply. Each entry names when
it applies. Each leaf is the **`principle-<title>`** skill, with the title in
kebab case, hyphens kept and other punctuation dropped, unless the entry gives
its name.

- **Laziness Protocol.** Refactoring, sizing a diff, or tempted to add
  abstractions, layers, or signal threading. Bias to deletion and the smallest
  change that solves the problem.
- **Foundational Thinking.** Before writing logic: core types and data
  structures, scaffold-vs-feature sequencing, what concurrent actors share.
- **Redesign from First Principles.** Integrating a new requirement into an
  existing design. Redesign as if it had been foundational from day one.
- **Attack the Premise.** Two or more fixes that share one premise have failed
  the same gate. Write the premise down and test it directly before you write
  another fix that assumes it.
- **Subtract Before You Add.** Sequencing an addition, refactor, or rewrite.
  Remove dead weight first, then build on the simpler base.
- **Minimize Reader Load.** Reviewing or shaping code that's hard to trace.
  Count layers and hidden state, collapse one-caller wrappers, shrink mutable
  scope.
- **Outcome-Oriented Execution.** Planned rewrites and migrations with explicit
  phase boundaries. Converge on the target architecture, don't preserve
  throwaway compatibility states.
- **Experience First.** Product, UX, or feature-scope tradeoffs. Choose user
  delight over implementation convenience.
- **Exhaust the Design Space.** A novel interaction or architectural decision
  with no precedent. Build 2-3 competing prototypes and compare before
  committing.
- **Build the Lever.** Any non-trivial work. Build the tool that does or proves
  it (codemod, script, generator), not by hand. The tool is the artifact a
  reviewer reruns.
- **Model the Domain.** Writing stateful logic, or code that branches a lot or
  repeats a shape assumption across files. Encode the domain in a structure
  (state machine, typed model, table or registry, reducer, boundary, the right
  collection) instead of scattered conditionals.
- **Boundary Discipline.** Wiring validation, error handling, or framework
  adapters. Guards at system boundaries, trust internal types, keep business
  logic pure.
- **Type System Discipline.** Designing types or a signature in any typed
  language. Make illegal states unrepresentable, brand primitives, parse
  external data at boundaries.
- **Make Operations Idempotent.** Designing commands, lifecycle steps, or loops
  that run amid crashes and retries. Converge to the same end state.
- **Migrate Callers Then Delete Legacy APIs.** Introducing a new internal API
  while old callers exist. Migrate and delete in one wave.
- **Separate Before Serializing Shared State.** Concurrent actors might write
  the same file, branch, key, or object. Eliminate the sharing first.
- **Prove It Works.** After a task, before declaring done. Verify against the
  real artifact, not a proxy or "it compiles".
- **Fix Root Causes.** Debugging. Trace each symptom back to the first place the
  system went wrong and fix it there. A guard is a fix only when the state it
  handles is legitimate.
- **Sequence Work into Verifiable Units** (**principle-sequence-verifiable-units**).
  Multi-step work (sweeps, migrations, runs of similar edits) and how you stack
  commits and PRs. Break work into small units that each end in a check, verify
  each before the next, and order delivery so the sequence proves itself.
- **Test Behavior, Not Implementation.** Writing, changing, or keeping a test.
  Assert what the code's users can observe, so the test fails when that behavior
  breaks and keeps passing when only the internals change.
- **Explain the Number.** Apply before you measure, and before you trust,
  report, or act on a number you measured (a speedup, a regression, a
  throughput, a latency, or an eval result). Find what limits it, and rule out
  that it measured something other than the work you think.
- **Guard the Context Window.** Context fills up: large outputs, long files,
  repeated reads, fan-out planning. Route bulk to subagents, keep summaries in
  the main thread.
- **Never Block on the Human.** Tempted to ask "should I do X?" on reversible
  work. Proceed, present the result, let the human course-correct.
- **Encode Lessons in Structure.** You catch yourself writing the same
  instruction a second time. Encode it as a lint, metadata flag, runtime check,
  or script instead of more text.

## TypeScript best practices

Read the [`typescript-best-practices` skill](.claude/skills/typescript-best-practices/SKILL.md)
before reading or editing `.ts` or `.tsx` files. Adapt the
[TypeScript type reference](vibestack/reference/typereferences.md)
to the repository's schema library. Validate that a duration is nonnegative
when it represents an ordered range.

Make the compiler reject impossible states, mismatched primitives, and
unhandled variants. Prefer defining errors and special cases out of existence
over proliferating handlers.

- **Brand semantic primitives.** Give `UserId` and `OrderId` distinct types, even
  if each is a string underneath. Use a branded intersection in TypeScript or
  a newtype elsewhere. Validate once at creation, then trust the type
  downstream. Brand arguments that share a primitive type and have different
  meanings.
- **External data is untyped until parsed.** Parse RPC payloads, JSON, IPC
  messages, CLI args, config files, environment variables, and database rows
  into the typed model at each boundary. See the
  [**boundary-discipline** principle skill](.claude/skills/principle-boundary-discipline/SKILL.md).
- **Derive types from authoritative schemas.** When a protocol buffer, OpenAPI
  spec, GraphQL schema, database migration, design-token file, or another file
  owns a shape, derive the type from that source. See the
  [**encode-lessons-in-structure** principle skill](.claude/skills/principle-encode-lessons-in-structure/SKILL.md).

| Rule | Summary |
|---|---|
| Discriminated unions | Model variants with a `kind` literal discriminant and give each variant exactly the fields it needs. |
| Branded types | Brand primitives with `& { readonly __brand: "X" }` to keep them distinct. Validate once at the boundary. Establish the brand with a verifying type guard such as `input is AgentId`. |
| Constructive modeling | Build the shape so the illegal value can't be constructed. Use `[T, ...T[]]` for a non-empty list, `[T, T][]` for an even number of elements, and `start` plus a `NonNegativeDuration` type for an ordered range. |
| Simplest total type | Keep `T[]` while every operation on it stays total. Strengthen to `NonEmpty<T>` only where the loose type forces `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown`. |
| Schemas before guards | Use the repository's runtime schema library and infer the type from the schema before writing a property-by-property guard. |
| Type assertions | Use an `as` cast only after validation. |
| Narrowing hierarchy | Prefer a discriminant switch, then `in`, then `typeof` or `instanceof`, then a user-defined type guard. A validated `as` cast is the last resort. |
| Type guards | Verify the full claim and name the guard `isX` or `hasX`. A misleading guard hides an unsafe assertion behind a name that promises safety. |
| Exhaustiveness | Inline `const _exhaustive: never = x;` in default arms so the compiler errors when a new variant is added. |
| `satisfies` over `as` | Check that a value conforms to a type while retaining the inferred type of the expression. |
| Boundary validation | Parse incoming data into a named domain type. Keep `Record<string, unknown>` and equivalent raw shapes on the input side of that parse. Trust the resulting types inside. See the **boundary-discipline** principle skill linked above. |
| Schema-derived types | Reach for `Pick`, `Omit`, `Parameters`, `ReturnType`, `Awaited`, or `typeof` before declaring a new interface. |
| Object args | Use named object properties to make arguments self-documenting. Positional arguments suit hot paths such as per-frame rendering, tokenizers, or parsers. |
| Real tests | Use real framework test primitives with leak and disposal checks, and verify UI in a running build. Mock only services you can't run locally, following the rules below. |
| Structured telemetry | Use structured logger diagnostics with enough context to debug from an ID. No `console.log` in shipped code. |

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

- **Journeys.** A test walks a story end to end, is named after it, and uses
  the required spec citation described below. A story whose path never leaves
  the verified core needs none.
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
  value over one per field.
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
  `project({ root: import.meta.dirname })` from `vibestack/testing/vitest.ts`, as
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
  in an owner's code too: `// spec/app/index.md, "…"`. Cite each `it` or
  `test` in its title or in the enclosing `describe` title, for example
  `'Check out (spec/index.md, "Story: Check out")'`. `check` fails on an
  uncited test or a citation with a missing heading. When a rule changes,
  `review` lists the code that cites it.
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
