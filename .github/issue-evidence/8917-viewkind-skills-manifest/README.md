# #8917 — ViewKind contract for sub-agents + min-plugin template

**Branch:** `feat/8917-viewkind-skills-manifest` (off `develop`)

## What #8917 asked for

1. `VIEW_KIND_CONTRACT` section in the min-plugin `SCAFFOLD.md` + guidance on the
   template's view entry.
2. A viewKind rule line in `buildCreatePrompt`.
3. **A ViewKind section in the economics SKILLS.md** so Cloud-deployed views are
   correctly categorized.

## State before this PR (measured on `develop`)

- (1) `min-plugin/SCAFFOLD.md` §"View kind" — **already merged** (PR #8962). The
  min-plugin template ships no `views` entry by design (README: "one provider,
  no UI"), so the guidance lives in SCAFFOLD.md rather than a template field.
- (2) `views-create.ts:461` `viewKindRule` — **already merged** (PR #8962),
  covered by `views-create.viewkind.test.ts` (3 tests, green).
- (3) **The economics SKILLS.md had no ViewKind content.** That SKILLS.md is the
  *generated* manifest the orchestrator writes to `workdir/SKILLS.md` for
  economics-profile tasks (`orchestrator-task-service.ts` →
  `buildSkillsManifest`). This was the only remaining gap.

## What this PR adds

- `skill-manifest.ts` gains an opt-in `includeViewKindContract` option that
  appends a "View kind" section documenting all four kinds (`release` default /
  `preview` / `developer` / `system` — never `system` for a created view),
  kept in sync with `resolveViewKind` (core default `release`).
- `orchestrator-task-service.ts` sets `includeViewKindContract: true` at the
  economics call site — the only production caller — so a Cloud-deploying
  sub-agent sees the contract. The generic manifest stays clean (off by default).

## Evidence in this folder

- `generated-economics-SKILLS.md` — the **actual** manifest produced by
  `buildSkillsManifest(..., { includeViewKindContract: true })` (same options the
  economics call site uses). See the `## View kind` section (lines ~23-32).

## Tests (green)

- `skill-manifest.test.ts` — appends the ViewKind contract when the flag is set
  (asserts all four kinds + `Do not use` + `resolves to release`); omits it by
  default. **4 passed** (2 new).
- `views-create.viewkind.test.ts` (merged slice) — **3 passed**, unchanged.

Typecheck + Biome clean for touched files.

## Note on the "developer" kind (issue ambiguity)

The issue's scenario expects a sub-agent to be able to assign `viewKind:
'developer'` for a dev-tooling view. The merged `viewKindRule` in
`views-create.ts` steers sub-agents to `release`/`preview` and forbids `system`
(silent on `developer`). This PR's SKILLS.md section documents `developer` as a
real option (dev tooling), matching the issue intent, without changing the
prompt's default steering.

## Verdict

`good` — the generated economics SKILLS.md now carries the ViewKind contract;
the SCAFFOLD.md + buildCreatePrompt asks were already merged and remain green.
