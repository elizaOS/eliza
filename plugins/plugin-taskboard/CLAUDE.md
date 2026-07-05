# @elizaos/plugin-taskboard

**Status: PLAN ONLY** ([elizaOS/eliza#13469](https://github.com/elizaOS/eliza/issues/13469)).
This directory holds the design for a not-yet-built plugin. No runtime code
ships here; `package.json` is `private` so the workspace does not try to build
it.

## What this is

Multi-agent **workboards**: one Eliza **room** + one GitHub **Projects v2 board**
+ one GitHub **tracking issue**, bound as a single durable object. Agents (and a
human owner) coordinate in the room at chat speed; work state lives on the board;
durable artifacts (decisions, evidence, findings) are mirrored to the tracking
issue for GitHub-native humans.

It composes primitives elizaOS already ships — rooms/entities/worlds
(`packages/core/src/types/environment.ts`), the scheduled-task spine
(`@elizaos/plugin-scheduling`), and GitHub access (`@elizaos/plugin-github`).

## Read these first

- **`README.md`** — the authoritative design: dependency direction, the
  rooms↔board data model, the GitHub sync strategy, the actions/providers/service
  surface, the structural goal loop, and the resolved open questions. Every claim
  cites a real primitive (`file:line`).
- **`SCAFFOLD.md`** — the build contract a coding agent follows to turn the plan
  into a working plugin (phase order, the one required `plugin-github` GraphQL
  extension, architecture rules, the real-GitHub E2E bar).

## Binding rules for the eventual build (from root `AGENTS.md`)

- Dependencies point inward only; MUST NOT import `@elizaos/app-core` /
  `@elizaos/agent` (mobile-bundle boundary, mirrors
  `@elizaos/plugin-scheduling`).
- One scheduler: the goal loop is a `ScheduledTask` on the existing spine, driven
  by **structural fields**, never by pattern-matching `promptInstructions`.
- One GitHub client: compose `plugin-github`'s `GitHubService`; do not fork a
  second Octokit.
- One board source of truth (the GitHub Project); the eliza-side card store is a
  reconcilable cache, never a second store of record.
- Logger only; strong types only; no fabricated defaults (`?? []` banned — "not
  loaded" ≠ "empty"); three-state UI.
