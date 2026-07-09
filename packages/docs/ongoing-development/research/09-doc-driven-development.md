# Doc-driven development + evidence-driven acceptance (process)

> Historical implementation record, captured during the 2026-07-04 process
> migration. Statements about working-tree state and missing files describe the
> branch at that time; the current operating contract lives in
> [`../README.md`](../README.md), [`../mvp/MVP.md`](../mvp/MVP.md), and the
> repository root `AGENTS.md`.

## Summary

We are converging the repo into one MVP: the **LifeOps Personal Assistant**
(GitHub project 15, https://github.com/orgs/elizaOS/projects/15) — chat,
onboarding, the current views, and centrally LifeOps: scheduling, calendar,
coordination, reminders, goals, todos, tasks. It must serve children, adults
with ADHD/ADD/Asperger's/autism, neurotypical people, and elderly people — with
no therapy language and no special rails; scenarios and tests cover real life
(brush teeth twice a day, work out, finish the report on time, night-owl sleep
rhythms). The guiding constraint is **minimize new scope**: turn what exists
into an MVP by fixing, testing, and verifying — prefer deleting over adding.

This workstream changes how we coordinate and how we prove work is done:

1. **Coordination** moves to GitHub Issues + Discussions + project board 15,
   with `packages/docs/ongoing-development/` as the source of truth for
   in-flight product thinking (discussion → design doc → issues on board 15 →
   PR with inline evidence → doc updated).
2. **Evidence** moves **inline into the GitHub issue/PR** — MP4 videos (render
   inline in GitHub), JPG screenshots (smaller than PNG), logs in `<details>`
   blocks. The repo-committed `.github/issue-evidence/` approach is retired: it
   bloated every clone (387 paths purged in `da86f5cce34`, and the committed
   tree previously broke Windows checkouts on `MAX_PATH` —
   `.github/workflows/vault-ci.yaml:52`), and it detached proof from the
   conversation it belonged to.

Most of the prose rewrite is **already applied** as working-tree edits on this
branch (verified below). What remains is: creating this folder's `README.md` +
`mvp/MVP.md` (root docs already link to them — the `markdown-links` CI lane is
red until they exist), aligning the mechanical PR-evidence gate, sweeping 546
per-package agent guides, migrating 3 residual evidence files to their issues,
and repointing CI scratch paths.

## Current state

**The binding standard and its mechanical gate exist and work:**

- `AGENTS.md` (243 lines) is the repo-wide definition of done; the root
  `CLAUDE.md`/`AGENTS.md` "Definition of Done" section restates it and every
  package guide points back to it.
- `.github/pull_request_template.md:85-106` carries 7 stable
  `<!-- evidence-row:… -->` markers; `scripts/check-pr-evidence.mjs:12-20`
  enumerates the same 7 rows and `.github/workflows/pr.yaml:17-30` runs the
  checker on every PR body, failing closed on blank/missing rows. For PRs
  labeled `ui`/`frontend`/`native`, screenshot/video rows require a concrete
  artifact reference (`scripts/check-pr-evidence.mjs:43-46,144-147`).
- The checker **already accepts GitHub inline attachments**: markdown links,
  any https URL, and the attachment hosts
  (`user-images.githubusercontent.com`, `github.com/**/assets/` — which matches
  the current `github.com/user-attachments/assets/<uuid>` rewrite) at
  `scripts/check-pr-evidence.mjs:57-68`. So the inline-evidence mechanics need
  **no new CI**; the gate was built for this.

**The repo-committed evidence directory is already dead, but half-buried:**

- Commit `da86f5cce34` (2026-07-04, "delete stuff") purged ~387
  `.github/issue-evidence/` paths, including the directory's `README.md`.
  Exactly 3 residual files remain, all for **closed** issues:
  `.github/issue-evidence/13617-develop-merge-gate/README.md` (85 lines, CI
  runbook incl. an unexecuted maintainer runbook for the develop merge gate),
  `13725-runtime-mode-gate-bare-agent.md` (83 lines),
  `13726-local-only-runtime-mode.md` (79 lines). All three are staged for
  deletion in this worktree — their content must be posted to their issues
  before the deletion merges, or the proof (and the #13617 F2 runbook) is lost.
- Stale acceptance vector: `scripts/check-pr-evidence.mjs:67` still satisfies
  an evidence row with a `.github/issue-evidence/…` path (which can no longer
  exist), and its self-test fixtures (`:200-203`) use such paths.
- 546 per-package agent guides carry one byte-identical line — ``Artifacts →
  `.github/issue-evidence/<issue#>-<slug>.<ext>`; attach each evidence type
  **or**`` — 273 in `CLAUDE.md`s + 273 in `AGENTS.md`s (verified by grep;
  pairs are enforced byte-identical by
  `scripts/assert-agents-claude-identical.mjs`, wired into `bun run verify` via
  `package.json` `check:agents-claude`). One mechanical sed sweep fixes all.
- CI/scripts still reference the dead path: `.github/workflows/test.yml:120,237`
  (TUI scratch dir + upload-artifact), `scenario-pr.yml:702`,
  `lifeops-live-validation-11632.yml:74-109`, `launch-hardening-8756.yml:54-61`,
  `browser-real-bench.yml:106-108` (all scratch-then-upload — functional but
  the path convention invites recommitting);
  `voice-live-e2e.yml:21,137,303,308,406` points operators at a **deleted**
  provisioning doc; `lifeops-benchmark-history.yml:95-141` **executes a script
  at a deleted path** — the workflow is broken on every run;
  `vault-ci.yaml:52` carries a stale "committed evidence files exceed
  MAX_PATH" comment; `package.json:105` (`audit:test-realness:evidence`)
  writes reports into the deleted dir;
  `packages/app/scripts/lib/issue-evidence.mjs:16-21` defaults all
  `capture:ios-sim`-family output into it.
- Dead links, failing CI today: `node scripts/check-markdown-links.mjs`
  (wired in `.github/workflows/markdown-links.yml:41`) currently reports 16
  missing targets: `docs/automation-glossary.md` (linked from root
  `CLAUDE.md:348`/`AGENTS.md:348` and
  `plugins/plugin-{scheduling,workflow,agent-orchestrator}/README.md` — the
  glossary was deleted in the purge although it is load-bearing one-scheduler
  doctrine), five deleted evidence files linked from
  `packages/ui/src/voice/STT_SELECTION.md`, and
  `packages/docs/ongoing-development/README.md` + `mvp/MVP.md` (linked by the
  new coordination prose, not yet created).

**The prose rewrite is already applied (uncommitted, this branch) — verified
file by file:**

- `AGENTS.md:75-83` — evidence table "Where it goes" column now says
  inline-in-PR per row; `AGENTS.md:134-156` — new section "Where evidence
  goes: inline in the issue/PR" (MP4-only video + ffmpeg convert line, JPG over
  PNG, `<details>` for logs, external-host fallback keeps an inline JPG still,
  explicit retirement of `.github/issue-evidence/`).
- `.github/pull_request_template.md:79-83` — attach inline, MP4/JPG rules, "do
  not commit evidence files"; `:122-125` — logs pasted inline in `<details>`.
- `.github/ISSUE_TEMPLATE/bug_report.md:21-26` — JPG/MP4 of the **wrong
  behavior** required for anything visible; `feature_request.md:21-26` —
  design-doc link + board-15 hint, MP4/JPG evidence-of-done list;
  `epic.md:13-17` — Design doc field; `:35` — inline-evidence acceptance
  criterion; `config.yml:3-5` — board-15 contact link.
- `CONTRIBUTING.md:29-32`, `README.md:126-135` — inline attachment guidance +
  board/discussions/ongoing-development pointers.
- Root `CLAUDE.md:376-399` (== `AGENTS.md`, verified byte-identical) — new
  25-line "Coordination — board, discussions, and ongoing-development docs"
  section: board 15 is the active kanban (claim = comment + move card; no
  unboarded MVP work), discussions per workstream, doc flow, inline evidence.
  This satisfies deliverable (d); no further edit proposed.

**What does not exist:** `packages/docs/ongoing-development/` had no files
before this research doc. There is no coordination README, no MVP doc, no
design/ or status/ convention. `packages/docs` is the Mintlify site
(`packages/docs/CLAUDE.md`); only `docs.json`-registered pages are published,
so an unregistered working folder is safe to add.

## Design considerations

- **Evidence must live where reviewers look.** An attachment in the PR body
  renders next to the claim it proves; a repo path requires a checkout and
  rots silently. GitHub attachments share the repo's durability class.
- **MP4, not MOV/WebM:** GitHub renders MP4 inline; other containers degrade to
  bare links. `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p out.mp4` is the
  documented conversion. GitHub caps attachment size — compress/trim; if a
  video cannot fit, host it, link it, and attach a representative JPG still
  inline so proof survives link rot.
- **JPG over PNG** for screenshots (smaller, faster review), PNG only where
  pixel-exact detail matters. Guidance, not a gate (see open question 1).
- **No new process machinery.** The gate (`check-pr-evidence.mjs`), the
  identity guard (`assert-agents-claude-identical.mjs`), the link checker, and
  the capture tooling all exist. This workstream edits text and deletes a
  convention; it adds zero new checks.
- **One source of truth for in-flight thinking.** Board 15 = task state;
  Discussions = conversation; `ongoing-development/` = durable decisions.
  Decisions made in a discussion must land as a doc PR — comments are not
  storage.

## Open questions → answers

1. **CI check that warns on PNG where JPG would do?** **No.** GitHub rewrites
   uploads to extensionless `github.com/user-attachments/assets/<uuid>` URLs —
   a body-side lint cannot see the content type without fetching every
   attachment, and would be pure noise. JPG-over-PNG stays template guidance.
2. **Grace period where the gate still accepts `.github/issue-evidence/`
   paths?** **No.** The directory is already purged; a path reference can only
   be stale or fabricated. Scope discipline forbids invented grace periods.
   Drop `scripts/check-pr-evidence.mjs:67` in the same PR that lands the
   template (in-flight PRs still pass via attachment URLs or `N/A - <reason>`).
3. **Where do CI-produced artifacts go if not committed?**
   `actions/upload-artifact` from `${{ runner.temp }}` — already the pattern in
   `test.yml`/`scenario-pr.yml`; only the scratch path moves out of the repo
   tree so nothing can recommit it. The author attaches the reviewer-relevant
   files inline in the PR.
4. **What about `lifeops-benchmark-history.yml`, which committed
   `score-history.jsonl` to the evidence dir?** It is broken today (executes a
   deleted script). **Delete the workflow** — fail fast, no zombie lanes. If
   the benchmarks workstream wants score history, it re-homes it on artifact
   storage under its own issue.
5. **Which discussion categories?** Master coordination thread →
   **Announcements** (maintainer-posted, pinned, low noise). One kickoff per
   workstream → **General**, titled `[MVP] <workstream>`. **Ideas** stays for
   unscoped proposals, which graduate by PR-ing a design doc into
   `ongoing-development/design/`. No new categories.
6. **Does `ongoing-development/` go into the published docs nav
   (`docs.json`)?** **No.** It is contributor-facing working material, not
   product docs. Mintlify publishes only nav-registered pages, so omission is
   sufficient.
7. **Automated status snapshots in `status/`?** **No.** Board 15 is live task
   truth; `status/` holds dated, human-written snapshots (e.g.
   `status/2026-07-05.md`) when a milestone warrants one. No tooling.
8. **Who writes `mvp/MVP.md`?** The MVP-definition workstream/owner. To keep
   `markdown-links` green now, land the stub in Appendix B and let that
   workstream replace it. (Owner call on final content; stub is the default.)
9. **Restore `docs/automation-glossary.md` or re-point 5 links?** **Restore
   the file at its original path** (`git show da86f5cce34^:docs/automation-glossary.md`).
   Zero link edits, and the glossary is load-bearing doctrine for the LifeOps
   one-scheduler architecture the MVP centers on. A later docs consolidation
   may move it; not now.

## Recommendation (minimal-scope MVP plan, ordered)

1. **P0 — Land the applied prose rewrite + create this folder.** Commit the
   already-applied edits (AGENTS.md, PR template, issue templates,
   config.yml, CONTRIBUTING.md, README.md, root CLAUDE.md/AGENTS.md) together
   with `ongoing-development/README.md` (Appendix A) and `mvp/MVP.md` stub
   (Appendix B) so `markdown-links` is green in one commit.
2. **P0/P1 — Align the mechanical gate:** drop the issue-evidence path
   acceptance and fixtures from `scripts/check-pr-evidence.mjs` (Appendix C).
3. **P1 — Preserve the 3 residuals:** post each file's content as a comment on
   closed issues #13617/#13725/#13726 (the #13617 file contains an unexecuted
   maintainer runbook), then let the staged deletion merge.
4. **P1 — Sweep the 546 per-package guides** (one sed, one uniform line) + fix
   the 5 dead links in `packages/ui/src/voice/STT_SELECTION.md`.
5. **P1 — Open the discussions** (master thread + workstream kickoffs; draft in
   this workstream's discussion file).
6. **P2 — Repoint CI/scripts scratch paths** off `.github/issue-evidence/`;
   delete `lifeops-benchmark-history.yml`; fix `voice-live-e2e.yml` doc refs;
   update `vault-ci.yaml:52`; fix `package.json:105`; repoint
   `packages/app/scripts/lib/issue-evidence.mjs`.
7. **P2 — Restore `docs/automation-glossary.md`** from `da86f5cce34^`.

## Out of scope (explicit non-goals for MVP)

- Any new CI gate (PNG lint, attachment-size checks, evidence-content
  validation beyond the existing row checker).
- GitHub issue **forms** (YAML templates) — the markdown templates were just
  tightened; a form migration is churn with no MVP payoff.
- Automated board sync, bots, status dashboards, or discussion tooling.
- Re-homing benchmark score history (benchmarks workstream, only if wanted).
- Publishing `ongoing-development/` on the docs site or any docs.json changes.
- Rewriting AGENTS.md beyond evidence-location mechanics — the three laws
  and the real-tests doctrine are untouched.

## Proposed issues

1. `[process] Create packages/docs/ongoing-development README + MVP stub (fixes red markdown-links lane)` — P0
2. `[process] check-pr-evidence: stop accepting retired .github/issue-evidence paths` — P1
3. `[process] Migrate the 3 residual .github/issue-evidence files to comments on their closed issues` — P1
4. `[process] Sweep 546 per-package CLAUDE.md/AGENTS.md evidence lines to inline-attachment guidance` — P1
5. `[process] Open the MVP coordination discussions (master thread + per-workstream kickoffs)` — P1
6. `[process] Repoint CI/scripts scratch paths off .github/issue-evidence and delete the broken benchmark-history workflow` — P2
7. `[process] Restore docs/automation-glossary.md deleted by the evidence purge` — P2

---

## Appendix A — proposed `packages/docs/ongoing-development/README.md`

```markdown
# Ongoing development — how we coordinate

Source of truth for in-flight product thinking on the way to the MVP: the
**LifeOps Personal Assistant** (chat, onboarding, the current views, and
centrally LifeOps — scheduling, calendar, reminders, goals, todos, tasks). It
serves children, adults with ADHD/ADD/Asperger's/autism, neurotypical people,
and elderly people alike — no therapy language, no special rails; scenarios
cover real life. Guiding constraint: minimize new scope — fix, test, and
verify what exists; prefer deleting over adding.

## Layout

- `mvp/` — the MVP definition ([`MVP.md`](../mvp/MVP.md)) and its status.
- `research/` — one research doc per workstream (numbered, e.g.
  `09-doc-driven-development.md`). Written once, then amended by PR as
  decisions change.
- `design/` — accepted design docs for features being built.
- `status/` — dated, human-written status snapshots (e.g. `2026-07-05.md`).

## How work flows

1. **Discussion** — conversation starts in
   [GitHub Discussions](https://github.com/elizaOS/eliza/discussions): one
   kickoff thread per workstream (General) + a pinned master coordination
   thread (Announcements).
2. **Design doc** — decisions land here as a PR (`research/` or `design/`).
   Discussion comments are not storage; if it was decided, it is in a doc.
3. **Issues on the board** — the doc is broken into implementation-ready
   issues on the
   [LifeOps Personal Assistant MVP board (project 15)](https://github.com/orgs/elizaOS/projects/15).
   Claim work by commenting on the issue and moving its card. Don't start
   unboarded MVP work.
4. **PR with inline evidence** — every PR proves itself inline per
   [`AGENTS.md`](../../../AGENTS.md): MP4 video (renders inline),
   JPG screenshots, logs in `<details>` blocks, real-LLM trajectories where
   agent behavior changed. Nothing committed to the repo.
5. **Doc updated** — if implementation diverged from the doc, the same PR
   updates the doc. A stale design doc is a bug.
```

## Appendix B — proposed `packages/docs/ongoing-development/mvp/MVP.md` stub

```markdown
# LifeOps Personal Assistant — MVP

> Stub: the MVP-definition workstream owns this file; replace via PR.

The MVP is chat, onboarding, the current views, and centrally **LifeOps**: all
scheduling, calendar, coordination, reminders, goals, todos, and tasks —
one personal assistant. It serves children, adults with
ADHD/ADD/Asperger's/autism, neurotypical people, and elderly people, with no
therapy language and no special rails: scenarios and tests cover real life
(brush your teeth twice a day, work out, get the report done on time, meet
life goals, manage a night-owl sleep rhythm).

Constraint: minimize additional scope. Turn what we have into an MVP by
fixing, testing, verifying, and validating the important stuff; prefer
deleting/simplifying over adding.

Live task state: [project board 15](https://github.com/orgs/elizaOS/projects/15).
Workstream docs: [`../research/`](../research/).
```

## Appendix C — `scripts/check-pr-evidence.mjs` edit spec

- `:67` — delete the final `return /\.github\/issue-evidence\/\S+/i.test(text);`
  from `hasArtifactReference` and end the function with `return false;` (the
  markdown-link, https, and attachment-host checks at `:58-65` remain).
- `:201` — fixture `"walkthrough-video"` becomes
  `"- [x] A video walkthrough: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000"`.
- `:203` — fixture `"backend-logs"` becomes
  `"- [ ] Backend logs: [run log](https://github.com/elizaOS/eliza/actions/runs/1)"`.
- Mirror the same fixture change in `scripts/check-pr-evidence.test.mjs` where
  it plants issue-evidence paths; run `--self-test` + the vitest file.
