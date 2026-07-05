# MVP definition, personas & UX journeys — LifeOps Personal Assistant

## Summary

The MVP (GitHub project 15) is: **chat, onboarding, the current views, and centrally LifeOps** — scheduling, calendar, coordination, reminders, goals, todos, tasks, personal assistant. It must serve business users, children, adults with ADHD/ADD/Asperger's/autism, neurotypical people, and elderly people — with **no therapy language and no special rails**: the same single interface, exercised against real life (brushing teeth twice a day, workouts, getting the report done on time for class, life goals, night-owl/irregular-sleep schedules, medication-adjacent routines without medical framing, bills, appointments, elderly check-ins).

The guiding constraint is **minimize additional scope**: turn what exists into an MVP by fixing, testing, verifying and validating the important stuff; prefer deleting/simplifying over adding.

**Decision this doc lands:** the feature surface is already sufficient for the MVP. The persona *machinery* is also already built — an eight-pack, 212-scenario persona corpus with a tier rubric and a coverage gate. What is missing is (a) **verification** — 78 of 212 catalog scenarios are authored-but-unverified, concentrated exactly in the neurodivergent packs (ADHD capture 8/28 verified, ADHD follow-through 5/24, shift-rotation 4/22); (b) **two persona voices with zero coverage** — a child as the user, and a student's "report due for class" deadline; (c) **the onboarding journey itself has no live scenario at all**; and (d) goals coverage is sleep-only. The plan below is verification-first and adds only scenario tests, never features.

## Current state (verified in code)

**One scheduler, structural behavior — real.** Every reminder/check-in/follow-up/watcher/recap/approval is a `ScheduledTask` routed through the runner at `plugins/plugin-scheduling/src/scheduled-task/runner.ts`; the personal-assistant side wires production deps in via `plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runtime-wiring.ts` (see `plugins/plugin-personal-assistant/README.md:8-57`). The runner matches only structural fields, never `promptInstructions` — the persona authoring guide restates this as binding (`plugins/plugin-personal-assistant/test/scenarios/_catalogs/LIFEOPS_PERSONA_SCENARIO_AUTHORING.md:34-36`). Personas live in data (owner facts, anchors, no-reply policies, reminder intensity), not in code branches — this is exactly the "no special rails" product requirement, already implemented.

**Default packs — real.** `daily-rhythm` (gm/gn/daily check-in, auto-enabled after the wake-time answer; `plugins/plugin-personal-assistant/src/default-packs/daily-rhythm.ts:1-15`), `habit-starters` (8 habits including brush-teeth, shower, water, offered at first-run; `src/default-packs/habit-starters.ts:2`), `morning-brief`, `quiet-user-watcher`, `executive-assistant` (25 records), `inbox-triage-starter`, `followup-starter` (`README.md:134-153`). Conservative no-reply defaults (reminder retries once after 60 min then `skipped`; sensitive approvals fail closed — `README.md:87-99`).

**Onboarding — real, thin, untested at journey level.** First-run runs **in the live chat** (`packages/ui/src/hooks/useAvailableViews.ts:388-391`), with two paths: fast-start (defaults) and customize — five questions (name, timezone+windows, categories multi-select, nudge channel, relationships cadence) with per-question persistence and resume (`plugins/plugin-personal-assistant/src/lifeops/first-run/questions.ts:1-75`, `first-run/service.ts:448-500`). Coverage today is jsdom component tests (`packages/ui/src/components/shell/ContinuousChatOverlay.firstrun.test.tsx`, `packages/ui/src/App.chat-overlay-first-run.test.tsx`) and first-run unit tests. **Zero scenarios in the whole corpus touch first-run/onboarding** (grep of `plugins/plugin-personal-assistant/test/scenarios/*.scenario.ts` and `packages/scenario-runner/test/scenarios/`).

**Scenario corpus — large, persona-organized, partially verified.** 271 `.scenario.ts` files in `plugins/plugin-personal-assistant/test/scenarios/`, all `lane: "live-only"` (`test/scenarios/README.md:3-7`). Keyless merge-blocking coverage lives in `packages/test/scenarios/reminders/` (13 deterministic reminder-ladder scenarios driving the real `/api/lifeops/reminders/process`) and `packages/scenario-runner/test/scenarios/deterministic-lifeops-*.scenario.ts` (5 spine scenarios through the real scheduler tick). The eight persona packs are tracked in `test/scenarios/_catalogs/*.catalog.json` with a tier rubric (T1 extraction → T4 adversarial) and a mechanical gate (`node packages/scripts/check-lifeops-persona-catalog-coverage.mjs --json`). Current output: **target 212, authored 212, verified 134**. Per pack:

| Pack | Persona | Verified / target |
|---|---|---|
| A1 adhd-capture-and-start | casey_adhd | **8 / 28** |
| A2 adhd-follow-through | casey_adhd | **5 / 24** |
| B1 night-owl-anchored-day | night_owl | 19 / 24 |
| B2 shift-rotation | rotating_shift | **4 / 22** |
| C1 traveler-timezone-truth | frequent_traveler | 25 / 28 |
| D1 comms-flood-triage | comms_flood | 24 / 26 |
| E1 low-activation-reengagement | low_activation | 25 / 28 |
| F1 neurotypical-control-adversarial | neurotypical_control | 24 / 32 |

"Verified" means a live-model run with a hand-read trajectory and judge score recorded in the catalog notes (e.g. `adhd-capture-and-start.catalog.json` entry `adhd-buried-commitment-ramble`: "Live Cerebras gpt-oss-120b run passed (judge 1.00)"). No CI lane runs the live-only corpus; verification is manual-with-evidence by design.

**Real-life matrix coverage today** (owner's list → feature → scenario test):

| Real-life scenario | Feature that covers it | Scenario tests |
|---|---|---|
| Brush teeth 2×/day | habit-starters pack + reminder ladder | 15 `brush-teeth-*` incl. 10 languages, night-owl, cancel/retry ✓ |
| Workouts | reminders + blockers | `workout-blocker-basic`, `workout-spanish`, `stretch-breaks` ✓ |
| Report done on time for class | OWNER_TODOS/CALENDAR + reminder escalation | **none — no student/child deadline scenario** ✗ |
| Life goals | plugin-goals + `OWNER_GOALS` + grounding loop (`plugins/plugin-goals/src/goal-grounding.ts`) | only `goal-sleep-{basic,spanish,french-formal}` — **sleep-only** ◐ |
| Night owl / irregular sleep | anchors + `relative_to_anchor` triggers | B1 pack, 19/24 verified ✓ |
| Rotating shifts | re-anchoring + sleep-window protection | B2 pack, **4/22 verified** ◐ |
| Medication-adjacent, no medical framing | plain reminders | `vitamins-*` ×3 languages, `adhd-medication-refill-fuzzy-date-capture` ✓ |
| Bills | `OWNER_FINANCES` + approval queue | `bill-approval-and-payment`, `quarterly-tax-payment-runbook` ✓ (executive-flavored) |
| Appointments | CALENDAR + day-before reminder | `persona-*` dentist family (elderly, ESL, typo, voice-transcript) ✓ |
| Elderly check-ins | daily-rhythm check-in + quiet-user-watcher | `persona-elderly-nontechnical` (single dentist scenario) ◐ |
| Child as user | same single interface | **none** ✗ |
| Onboarding → first win | first-run service + seeded packs | **no live scenario** ✗ |

**Views today.** The launcher builds from `GET /api/views` plus ~30 builtin shell tabs (`packages/ui/src/hooks/useAvailableViews.ts:209-291`): chat, tasks, automations, triggers, documents, files, relationships, memories, plus developer surfaces (trajectories, runtime, database, logs, plugins, skills). Domain views live in per-domain plugins (`plugins/plugin-todos`, `plugin-goals`, `plugin-calendar`, `plugin-inbox`, `plugin-reminders`, `plugin-relationships`, `plugin-blocker`, `plugin-finances`); PA itself has no overview view by owner decision (`plugins/plugin-personal-assistant/CLAUDE.md`, "Views" section). A four-tier `viewKind` gate (`system`/`release`/`developer`/`preview`) exists (`useAvailableViews.ts:78-84`) — whether a fresh non-developer user actually sees only an MVP-sized view set is unverified.

**Doc drift (small, real).** Root `CLAUDE.md:348` / `AGENTS.md:348` still link `docs/automation-glossary.md`, deleted in commit `da86f5cce34` ("delete stuff"). Every agent following the LifeOps pointer hits a dead link.

**Bench context.** `packages/benchmarks/lifeops-bench` (Python) has a 10-persona library (`eliza_lifeops_bench/scenarios/_personas.py`) including an adult-diagnosed-ADHD designer (Casey Brennan, `_personas.py:265`) and comms-flooded executives — but no child and no elderly persona there either.

## Design considerations

- **Chat is the product; views are read surfaces.** Every persona journey below starts and mostly stays in chat. Views doctrine (uniform top bar, no side panels, no suggestion chips, agent-proactive-on-view-switch, view-scoped actions) is already adopted; nothing here adds view chrome.
- **"No special rails" is already the architecture.** Persona differences are owner facts + structural knobs (reminder intensity, anchors, no-reply policy, quiet hours) consumed by one runner. The MVP work is proving each persona's knob-set produces the right behavior, not building persona modes.
- **What competitors prove users love** (one-pass check of the ADHD/executive-function landscape — [Tiimo alternatives](https://lifestack.ai/blog/tiimo-alternative), [best ADHD apps 2026](https://blog.saner.ai/best-adhd-apps/), [executive-function apps](https://www.saner.ai/blogs/best-apps-for-executive-function)): Tiimo wins on making time *tangible* (visual timelines against time blindness); Goblin Tools wins on **task initiation** — breaking "clean the kitchen" into micro-steps with zero setup; Finch wins on low-pressure, non-shaming motivation. Our corpus already encodes all three as behaviors: `adhd-task-initiation-two-minute-step`, `lowact-make-whole-list-smaller-bulk-shrink`, `f1-shame-bait-declined-productivity-lecture`. The differentiator we have that they don't: one conversational agent across the user's real channels (Telegram/iMessage/Discord/WhatsApp) that *does the coordinating*, instead of another app to open. That makes **capture-from-mess and follow-through** the two make-or-break loops — precisely the two least-verified packs.
- **Children and elderly need the same interface, gentler defaults.** The elderly persona scenario proves rambling non-technical phrasing works for one appointment; children need the same proof for their real life (homework, morning routine) in child-plain language. In-app + push are the child-safe channels (no email/finance surface needed).
- **Verification is the scarce resource.** A live-verified scenario with a hand-read trajectory is worth more to the MVP than any new capability. The catalog `status` field + coverage gate already give us a mechanical definition of done.

## Personas (7)

Each: context → journey (first-open → onboarding → first win → week 2) → loves / struggles → intuitiveness fix. Struggles are grounded in the current UX, not hypotheticals. Where a bench persona already exists, reuse its name for continuity with `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_personas.py`.

**P1 — Casey, 29, product designer with ADHD** (phone-first; Telegram connector; maps to packs A1/A2 and bench persona Casey Brennan, `_personas.py:265`).
- *First-open → onboarding:* opens the app mid-chaos, takes fast-start — zero questionnaire tolerance.
- *First win:* dumps a rambling multi-topic message; the one buried commitment ("call pharmacy before 5") is captured and fires on time (`adhd-buried-commitment-ramble`, verified at judge 1.00).
- *Week 2:* the follow-through ladder chases twice then shrinks the ask; a missed step gets a replan, never a lecture (`adhd-followthrough-missed-step-replan-without-guilt` — authored, unverified).
- *Loves:* capture-from-mess with no forms; non-shaming retries; the two-minute-step task-initiation help (`adhd-task-initiation-two-minute-step`).
- *Struggles:* trust — only 13 of 52 ADHD-pack scenarios are verified; if capture or escalation misbehaves once, the app gets deleted (`adhd-followthrough-rage-quit-delete-trap` encodes exactly this).
- *More intuitive:* nothing new — verify A1/A2 to the same bar as C1/D1/E1.

**P2 — Sam, 12, middle-schooler** (hand-me-down phone; in-app + push only — no email, no finance surface).
- *First-open → onboarding:* parent provisions the device; Sam answers "What should I call you?" and accepts brush-teeth from the offered habit-starters.
- *First win:* morning brush-teeth nudge in kid-plain words, marked done from chat.
- *Week 2:* "i have a book report friday and i haven't started" → captured todo, back-planned steps, done on time.
- *Loves:* it talks like a person, not a chore chart; no app maze.
- *Struggles:* customize Q2 ("What time zone are you in, and what counts as your morning / evening?") and Q5 ("relationships and default cadence", `questions.ts:46-70`) are adult-worded; multi-select-in-chat is hard at 12. Zero scenarios exist in a child's voice.
- *More intuitive:* fast-start must be genuinely sufficient (structurally it is — the defaults pack needs only wake time); prove it with child-voice scenarios instead of rewording anything.

**P3 — Priya, 21, college student, night owl** (laptop + phone; Discord connector; maps to pack B1).
- *First-open → onboarding:* onboards at 2am; states morning = 11:00–14:00 and it is accepted without judgment.
- *First win:* her day anchors to her actual wake, not 7am (`night-owl-observed-wake-drift-adaptation`, verified pack pattern).
- *Week 2:* term-paper deadline back-planned across her real, nocturnal work windows; quiet-hours sleep protection holds (`persona.night-owl-quiet-hours-sleep-protection`).
- *Loves:* `relative_to_anchor` scheduling — the assistant that doesn't assume mornings (B1 is 19/24 verified).
- *Struggles:* deadline work — the student "report due for class" flow has zero scenarios; today that journey is exercised only by executive-flavored flows.
- *More intuitive:* student-voice deadline scenarios asserting the reminder ladder fires inside her active windows.

**P4 — Ray, 47, rotating-shift nurse** (Android; WhatsApp/SMS connector; maps to pack B2).
- *First-open → onboarding:* onboards between shifts; fast-start, then tells the agent the roster.
- *First win:* "nights starting Monday" re-anchors gm/gn and protects the new sleep window (`shift-rotation-capture-new-shift-pattern` — authored, unverified).
- *Week 2:* a shift swap re-anchors routines and holds low-priority nudges during the moved sleep window.
- *Loves:* the only assistant whose "morning" moves with the roster; medication-adjacent routines stay plain reminders (vitamins pattern), no medical framing.
- *Struggles:* B2 is the least-verified pack (4/22) — re-anchoring is exactly the behavior most likely to be silently wrong, and a wrong anchor wakes a night-shift nurse at 7am.
- *More intuitive:* verify B2; nothing new.

**P5 — Marcus, 33, autistic software engineer** (desktop app; Discord connector; maps to packs E1 + F1).
- *First-open → onboarding:* chooses the customize path deliberately — he wants the explicit five questions and explicit defaults.
- *First win:* plans stated literally and executed exactly as stated; two-phase preview-then-confirm before any write (authoring rule 3).
- *Week 2:* predictable check-in cadence, no surprise tone shifts, no unsolicited scaffolding (`f1-neurotypical-no-scaffolding-unless-signaled` — authored, unverified — is his control test too).
- *Loves:* structural predictability — same trigger, same wording, same time; the runner's structural-fields-only contract is what makes this a guarantee rather than a vibe.
- *Struggles:* the launcher merges ~30 builtin tabs including `trajectories`/`runtime`/`database` (`useAvailableViews.ts:209-246`) — overwhelming and off-doctrine for a fresh install if `viewKind` gating leaks.
- *More intuitive:* verify the fresh-user view set is the curated MVP set.

**P6 — Dot, 74, retired teacher** (iPad; iMessage; daughter set it up).
- *First-open → onboarding:* daughter completes setup; Dot talks to it like a person ("Hello dear, I hope I am doing this right…").
- *First win:* dentist Thursday 3pm captured from a rambling paragraph + day-before reminder (`persona-elderly-nontechnical` — the verified pattern).
- *Week 2:* daily check-in she reliably answers; the quiet-user-watcher catches the day she doesn't; bill reminders in plain words.
- *Loves:* no menus, no tech vocabulary required; the agent arranges around her ("so I have time to arrange the bus").
- *Struggles:* one verified scenario covers her entire life; the daily check-in → missed-checkin → gentle follow-up loop — her family's actual reason for installing it — is covered only generically, and its no-reply leg (check-ins retry once after 24h then `expired`, `README.md:91`) is unverified in her voice.
- *More intuitive:* verify the elderly week-1 loop end-to-end including the no-reply path and the re-engagement tone bar.

**P7 — Elena, 41, small-business owner** (desktop + iPhone; Gmail + Google Calendar connectors; maps to packs D1 + F1 and the executive-assistant pack).
- *First-open → onboarding:* customize path; enables inbox triage + follow-ups (Q3 categories, gated on Gmail for the triage pack).
- *First win:* morning brief with the three things that matter (`morning-brief` pack on `wake.confirmed`).
- *Week 2:* VIP breakthrough during quiet hours (`comms-flood-quiet-hours-vip-exception`, verified), bill approval that fails closed on silence (`README.md:96-99`).
- *Loves:* comms-flood triage (D1 24/26 verified) and the approval queue's conservative no-reply defaults.
- *Struggles:* nothing structural — she is the best-covered persona. Her risk is regression while the neurodivergent packs get attention, which is F1's whole job (24/32 verified).
- *More intuitive:* keep F1 green; no changes.

## Open questions → answers

**Q1. Do children as users change product scope (parental controls, COPPA-style gating)?** Owner said children are in scope with no special rails. *Answer:* treat the child as an owner on a device a parent provisioned; restrict nothing in-product for MVP beyond what fast-start already implies (no finance/inbox packs offered without connectors). Compliance/account-holder questions are a Cloud/legal concern, not a LifeOps runtime concern — **needs owner sign-off eventually; default: no in-product gating for MVP.**

**Q2. Should onboarding questions be reworded for children/elderly?** *Answer:* no rewrite for MVP. Fast-start already bypasses the adult-worded customize questions, and the planner (a live LLM) renders questions conversationally — the strings in `questions.ts` are a contract, not verbatim UI. Prove with scenarios that fast-start + chat handles a child and an elderly user; only touch wording if scenarios fail.

**Q3. Is a new "child pack" or "student pack" needed?** *Answer:* no. `habit-starters` + reminder ladder + OWNER_TODOS already cover the child/student matrix rows. The gap is scenario coverage (child voice, homework deadline), not features. Adding packs would violate the minimize-scope constraint.

**Q4. Should the live-only persona corpus get a CI lane?** *Answer:* not for MVP. The manual verify-with-evidence flow (catalog `status` + hand-read trajectories) matches PR_EVIDENCE doctrine and costs nothing in CI keys/flake. The coverage gate script already makes progress mechanical. Revisit post-MVP with a nightly budget.

**Q5. Which model verifies scenarios?** *Answer:* follow existing precedent — verified entries used live Cerebras `gpt-oss-120b` (catalog notes; recipe in team memory). Any live model qualifies per PR_EVIDENCE ("live model, not the proxy"); record model + judge score in the catalog note as existing entries do.

**Q6. Do we need a goals overhaul for "life goals"?** *Answer:* no. The grounding loop (push for a success definition → preview → confirm) is goal-agnostic (`plugins/plugin-goals/src/goal-grounding.ts`); only the scenario corpus is sleep-only. Author non-sleep goal scenarios (fitness, savings, learning) against the same loop.

## Recommendation (ordered, minimal-scope)

1. **Verify the ADHD packs (A1, A2)** — 39 authored-unverified scenarios in the make-or-break capture + follow-through loops. Live runs, hand-read trajectories, catalog `status` flips with evidence inline in the PR.
2. **Verify the shift-rotation pack (B2)** — 18 unverified; irregular-sleep re-anchoring is the highest-silent-failure-risk behavior.
3. **Author + verify the two zero-coverage persona voices**: child daily routine (P2) and student report-deadline (P2/P3), as `live-only` scenarios in the existing corpus with catalog entries. Scenarios only; no features.
4. **Author + verify the onboarding journey scenario** (fast-start and customize) → seeded `daily-rhythm`/offered `habit-starters` → first reminder actually materialized. This is the funnel's first mile and currently has only jsdom tests.
5. **Verify the elderly week-1 loop** (daily check-in fires → answered → missed → quiet-user follow-up) building on `persona-elderly-nontechnical`.
6. **Broaden goals beyond sleep** with 3–4 non-sleep goal-grounding scenarios.
7. **Verify the fresh-user MVP view set** (`viewKind` gating hides developer/preview surfaces) and finish F1 control verification (8 remaining) so neurotypical behavior doesn't regress.
8. **Fix the dead `docs/automation-glossary.md` link** in root CLAUDE.md/AGENTS.md (restore or repoint) — trivial, but every coordinating agent trips on it.

## Out of scope (MVP non-goals)

- New default packs, persona "modes", child/elderly UI variants, or any therapy-adjacent framing or rails.
- Visual-timeline / gamification features (competitor parity) — chat + reminders + views as they exist.
- A CI lane for the live-only corpus; nightly live benchmarking (LifeOpsBench continues separately).
- Onboarding question rewrites, new views, view chrome, or launcher redesign beyond verifying existing `viewKind` gating.
- New connectors; anything in `executive-assistant` pack beyond keeping F1/D1 green.

## Proposed issues

1. [mvp] Verify ADHD capture + follow-through packs (A1 8/28, A2 5/24) with live-LLM runs — P0
2. [mvp] Verify shift-rotation pack B2 (4/22) — irregular-sleep re-anchoring — P0
3. [mvp] Author + verify child-voice and student report-deadline scenarios (zero coverage today) — P0
4. [mvp] Author + verify first-run onboarding journey scenarios (fast-start + customize → first reminder) — P1
5. [mvp] Verify elderly week-1 loop: daily check-in, missed-checkin follow-up, quiet-user watcher — P1
6. [mvp] Author + verify non-sleep life-goal grounding scenarios (goals corpus is sleep-only) — P1
7. [mvp] Verify fresh-user MVP view set + finish F1 neurotypical-control pack (24/32) — P2
8. [mvp] Fix dead docs/automation-glossary.md link in root CLAUDE.md/AGENTS.md — P2
