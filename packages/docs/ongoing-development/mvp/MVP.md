# LifeOps Personal Assistant — MVP

The first doc to read. It defines what the MVP is, who it serves, what is in
and out of scope, an honest assessment of where the code stands, and the bar
each of the nine workstreams must clear to be called done. It synthesizes the
nine workstream research docs under `research/`; each section links back to the
doc that owns the detail.

Live task state: [project board 15](https://github.com/orgs/elizaOS/projects/15).
Coordination and evidence mechanics: [`../README.md`](../README.md).

## Product definition

The MVP is **chat, onboarding, the current views, and centrally LifeOps** — all
scheduling, calendar, coordination, reminders, goals, todos, and tasks, as one
personal assistant. Chat is the product; views are read surfaces the agent (or
the user, via chat) drives.

It must serve **business users, children, adults with ADHD/ADD/Asperger's/
autism, neurotypical adults, and elderly people** — through the *same single
interface*, with **no therapy language and no special rails**. There are no
persona "modes" and no audience-segmented flows. The product meets each audience
by covering their real life against the same machinery: brushing teeth twice a
day, workouts, getting the report done on time for class, life goals, night-owl
and rotating-shift sleep rhythms, medication-adjacent routines with no medical
framing, bills, appointments, and elderly check-ins.

"No special rails" is already the architecture, not an aspiration. Persona
differences are **owner facts + structural knobs** — reminder intensity,
anchors, no-reply policy, quiet hours — consumed by one runner
(`plugins/plugin-scheduling/src/scheduled-task/runner.ts`), which matches on
structural fields and never on `promptInstructions` text. The MVP work is
proving each persona's knob-set produces the right behavior, not building
persona machinery ([research/01](../research/01-mvp-product-personas.md)).

The guiding constraint is **minimize additional scope**: turn what exists into
an MVP by fixing, testing, verifying, and validating the important stuff. Prefer
deleting and simplifying over adding. Every workstream doc independently reached
the same conclusion — the feature surface is already sufficient; the missing
thing is verification.

## Personas & journeys

Eight personas, condensed from [research/01](../research/01-mvp-product-personas.md).
Where a bench persona already exists
(`packages/benchmarks/lifeops-bench/.../scenarios/_personas.py`), the name is
reused for continuity. Each maps to a pack in the persona scenario corpus.

**P1 — Casey, 29, product designer with ADHD** (Telegram; packs A1/A2).
Opens the app mid-chaos and takes fast-start — zero questionnaire tolerance.
First win: a rambling multi-topic dump where the one buried commitment ("call
pharmacy before 5") is captured and fires on time. Week 2: the follow-through
ladder chases twice then shrinks the ask; a missed step gets a replan, never a
lecture. *Loves:* capture-from-mess with no forms, non-shaming retries, the
two-minute-step task-initiation help. *Struggles:* trust — only 13 of 52
ADHD-pack scenarios are verified, and one misbehaving capture or escalation gets
the app deleted. *Intuitive fix:* nothing new — verify A1/A2 to the bar the
other packs already meet.

**P2 — Sam, 12, middle-schooler** (in-app + push only; no email, no finance).
A parent provisions the device; Sam answers "What should I call you?" and
accepts brush-teeth from the offered habits. First win: a morning brush-teeth
nudge in kid-plain words, marked done from chat. Week 2: "i have a book report
friday and i haven't started" → captured todo, back-planned, done on time.
*Loves:* it talks like a person, not a chore chart. *Struggles:* the customize
questions are adult-worded and multi-select-in-chat is hard at 12; **zero
scenarios exist in a child's voice.** *Intuitive fix:* prove fast-start is
genuinely sufficient with child-voice scenarios — don't reword anything.

**P3 — Priya, 21, college student, night owl** (Discord; pack B1). Onboards at
2am; states morning = 11:00–14:00 and it is accepted without judgment. First
win: her day anchors to her actual wake, not 7am. Week 2: a term-paper deadline
back-planned across her real nocturnal work windows, sleep protection holding.
*Loves:* `relative_to_anchor` scheduling — the assistant that doesn't assume
mornings. *Struggles:* the student "report due for class" flow has **zero
scenarios**; it's exercised today only by executive-flavored flows. *Intuitive
fix:* student-voice deadline scenarios asserting the ladder fires inside her
active windows.

**P4 — Ray, 47, rotating-shift nurse** (WhatsApp/SMS; pack B2). Onboards between
shifts; fast-start, then tells the agent the roster. First win: "nights starting
Monday" re-anchors gm/gn and protects the new sleep window. Week 2: a shift swap
re-anchors routines and holds low-priority nudges during the moved sleep window.
*Loves:* the only assistant whose "morning" moves with the roster;
medication-adjacent routines stay plain reminders, no medical framing.
*Struggles:* B2 is the **least-verified pack (4/22)** — re-anchoring is exactly
the behavior most likely to be silently wrong, and a wrong anchor wakes a
night-shift nurse at 7am. *Intuitive fix:* verify B2.

**P5 — Marcus, 33, autistic software engineer** (desktop; Discord; packs
E1/F1). Deliberately chooses the customize path — he wants the explicit
questions and explicit defaults. First win: plans stated literally and executed
exactly as stated, with two-phase preview-then-confirm before any write. Week 2:
predictable check-in cadence, no surprise tone shifts, no unsolicited
scaffolding. *Loves:* structural predictability — same trigger, same wording,
same time; the runner's structural-fields-only contract makes this a guarantee
rather than a vibe. *Struggles:* the launcher merges ~30 builtin tabs (including
`trajectories`/`runtime`/`database`) — overwhelming for a fresh install if the
`viewKind` gate leaks. *Intuitive fix:* verify the fresh-user view set is the
curated MVP set.

**P6 — Dot, 74, retired teacher** (iPad; iMessage; daughter set it up). The
daughter completes setup; Dot talks to it like a person. First win: dentist
Thursday 3pm captured from a rambling paragraph + a day-before reminder. Week 2:
a daily check-in she reliably answers, the quiet-user-watcher catching the day
she doesn't, bill reminders in plain words. *Loves:* no menus, no tech
vocabulary required. *Struggles:* one verified scenario covers her entire life;
the check-in → missed → gentle follow-up loop — her family's actual reason for
installing it — is covered only generically, and its no-reply leg is unverified
in her voice. *Intuitive fix:* verify the elderly week-1 loop end to end
including the no-reply path.

**P7 — Elena, 41, small-business owner** (Gmail + Google Calendar; packs
D1/F1 + executive-assistant). Customize path; enables inbox triage + follow-ups.
First win: a morning brief with the three things that matter. Week 2: a VIP
breakthrough during quiet hours, a bill approval that fails closed on silence.
*Loves:* comms-flood triage (D1 24/26 verified) and the approval queue's
conservative no-reply defaults. *Struggles:* nothing structural — she is the
best-covered persona; her risk is regression while the neurodivergent packs get
attention. *Intuitive fix:* keep F1 green.

**P8 — Jordan, 39, separated co-parent** (iMessage + Calendar; planned pack
J1). Fast-start, then connects calendar and messages when custody logistics
become the immediate pain. First win: recurring exchange reminders and a
neutral calendar view of the custody rhythm. Week 2: a last-minute swap request
becomes an owner-approved, civil logistics draft without exposing child details
or giving legal or therapy advice. *Loves:* factual language and coordination
across both households. *Struggles:* the cross-domain handoff between scheduling,
money, messaging, and child privacy has a planned ledger but no uniformly
verified scenario pack. *Intuitive fix:* verify J1 end to end rather than add a
co-parent-specific product mode.

## Real-life scenario matrix

The owner's real-life list → the feature that covers it → scenario-test status,
from [research/01](../research/01-mvp-product-personas.md). ✓ covered and
verified · ◐ partial / thin · ✗ no coverage.

| Real-life scenario | Feature that covers it | Test status |
| --- | --- | --- |
| Brush teeth 2×/day | habit-starters pack + reminder ladder | ✓ 15 `brush-teeth-*` incl. 10 languages, night-owl, cancel/retry |
| Workouts | reminders + blockers | ✓ `workout-blocker-basic`, `workout-spanish`, `stretch-breaks` |
| Report done on time for class | OWNER_TODOS/CALENDAR + reminder escalation | ✗ no student/child deadline scenario |
| Life goals | plugin-goals + `OWNER_GOALS` + grounding loop | ◐ sleep-only (`goal-sleep-{basic,spanish,french-formal}`) |
| Night owl / irregular sleep | anchors + `relative_to_anchor` triggers | ✓ B1 pack, 19/24 verified |
| Rotating shifts | re-anchoring + sleep-window protection | ◐ B2 pack, 4/22 verified |
| Medication-adjacent, no medical framing | plain reminders | ✓ `vitamins-*` ×3, `adhd-medication-refill-fuzzy-date-capture` |
| Bills | `OWNER_FINANCES` + approval queue | ✓ `bill-approval-and-payment`, `quarterly-tax-payment-runbook` |
| Appointments | CALENDAR + day-before reminder | ✓ `persona-*` dentist family (elderly, ESL, typo, voice) |
| Elderly check-ins | daily-rhythm check-in + quiet-user-watcher | ◐ single `persona-elderly-nontechnical` scenario |
| Child as user | same single interface | ✗ none |
| Onboarding → first win | first-run service + seeded packs | ✗ no live scenario |

## Scope: in / out

**In scope.** Chat as the primary surface (continuous overlay, gestures,
scrolling, search, mic). Cloud-only in-chat onboarding + chat-native tutorial +
help-as-knowledge. The current views as read surfaces the agent drives. LifeOps:
scheduling, calendar, reminders, goals, todos, tasks, coordination — one
scheduler, structural behavior. The in-chat widget vocabulary (form, choice,
followups, task, secret/oauth, `[CONFIG]`). A sparse resting home
(time/weather + notifications + wallet). Bidirectional voice on every surface.
On-device Android + iOS fleet e2e. Doc-driven coordination + inline evidence.
The unifying constraint: **fix / test / verify, don't add.**

**Out of scope** (aggregated from every workstream's non-goals):

- New default packs, persona "modes", child/elderly UI variants, or any
  therapy-adjacent framing or rails. Onboarding question rewrites, new
  onboarding steps/wizards, name pickers, provider marketplaces
  ([01](../research/01-mvp-product-personas.md), [04](../research/04-onboarding-tutorial-help.md)).
- A new widget framework, registry, or renderer; per-plugin marker kinds; a
  hosted generic `/forms/:id` page; a widget builder or user-authored widgets
  ([02](../research/02-chat-widget-system.md)).
- New home widgets, a widget-settings/customization surface, launcher-tile or
  rail-gesture changes, a second notification surface, new server-side
  wallet/price plumbing ([03](../research/03-launcher-widgets.md)).
- Re-adding a Help view or searchable FAQ; redesigning the tutorial; live
  investment in the flagged local-model onboarding path beyond flag-boundary
  tests ([04](../research/04-onboarding-tutorial-help.md)).
- Thread virtualization, framer-motion replacement, sheet-animation rework;
  cross-conversation UI beyond search-jump; semantic/vector message search;
  feature work on the kiosk/detached chat paths ([05](../research/05-chat-window-ux.md)).
- New views, tabs, or layouts; write actions for read-only diagnostic surfaces;
  semantic actions for third-party plugin views; the voice implementation itself
  ([06](../research/06-views-chat-integration.md)).
- On-device Whisper (retired, stays retired); new TTS voices / voice cloning;
  cloud Kokoro streaming synthesis; any new bespoke voice test harness
  ([07](../research/07-voice-pipeline.md)).
- Greening the CI x86_64 emulator; per-appex provisioning-profile minting; any
  device-farm / remote-brokering service; store-release / TestFlight automation
  ([08](../research/08-device-testing-pipeline.md)).
- Any new CI gate; GitHub issue forms; automated board sync / status dashboards;
  a CI lane for the live-only persona corpus; publishing this folder on the docs
  site ([01](../research/01-mvp-product-personas.md), [09](../research/09-doc-driven-development.md)).

## What we have / what's weak / what's missing

The honest read, aggregated from every workstream's current-state section. The
pattern is consistent: **the architecture is built and mostly right; the gap is
verification and a handful of concrete correctness bugs.**

**What we have (built and working).** One scheduler with structural,
data-driven persona behavior. Seven default packs with conservative no-reply
defaults. Cloud-only in-chat onboarding, chat-native tutorial, and
help-as-knowledge — all shipped (#13377, PRs #13393/#13521/#13394). The
plugin-extensible inline widget registry, the typed connector-agnostic
interaction protocol in `@elizaos/core`, and the out-of-band sensitive-request
pipeline with a real hosted page. The chat gesture/detent system (pull-to-
maximize landed #13531, CI-gated). A `view:interact` protocol + generic
agent-surface bridge with ~40 views opted in. On-device Kokoro TTS on all three
native surfaces and measured fused ASR on desktop (WER 0.008, RTF 0.262).
Per-platform e2e orchestrators, a physical-iPhone deploy pipeline, a
content-derived renderer build stamp. A working PR-evidence gate that already
accepts inline GitHub attachments.

**What's weak.** The persona corpus is **134/212 verified**, and the shortfall
concentrates exactly in the make-or-break neurodivergent packs — ADHD capture
**8/28**, ADHD follow-through **5/24**, shift-rotation **4/22**. The widget
round-trips have **zero live-LLM scenario coverage**. The home carries seven
non-MVP widgets and a wallet that contradicts its own doctrine (hides with no
holdings, prices never refresh); an `AppRunsWidget` polls every 5s ungated.
Cloud voice now has a committed Railway benchmark and a scheduled live contract
lane, the client cloud-ASR path is wired, the STT model is deploy-configurable,
and reproducible Kokoro/Whisper Railway service definitions live in-repo.
However, the scheduled lane still lacks a green owner-provisioned Railway run,
and no browser test proves real mic audio reaches Railway Whisper and returns an
audible live-agent reply. The chat transcript
can silently become horizontally scrollable (`overflow-y-auto` without
`overflow-x-hidden`), and the perf gate carries a known-red CLS 0.80 failure.
Several view mutations (settings sections, documents, memories, files) have only
the brittle synthetic-DOM path, no semantic action — a dead end for voice.

**What's missing.** Two persona voices with **zero** coverage (child-as-user,
student report-deadline) and **no live onboarding-journey scenario at all**;
goals coverage is **sleep-only**. History pagination in chat (a hard 80-row cap
over a 200-message window, no `before` cursor) and message search reachable from
the primary surface (it exists end-to-end but is mounted only in the desktop
detached shell). **The onboarding verification of record is dead** —
`app-live-e2e.yml`, the only lane proving a real cloud account + real LLM work
after onboarding, has had **no green run since ≤2026-06-25** (failure/cancelled
every scheduled run for 10+ days), and no device lane covers the production
default cloud sign-in path. The Android runner **runs stale builds by default**
(install-if-missing skips fresh APKs — the Capacitor bake-in footgun, live in
the runner). Railway ownership and live deploy evidence remain unproven even
though the service definitions and scheduled contract lane are in-repo.

## Workstreams

The nine research docs, one line each. Full detail behind each link.

1. [MVP, personas & UX journeys](../research/01-mvp-product-personas.md) —
   verify the persona corpus to a uniform bar; author the two zero-coverage
   voices + the onboarding scenario; scenarios only, no features.
2. [In-chat widget system](../research/02-chat-widget-system.md) — fix the dead
   connector form-link, add date/time field types, and prove the widget +
   settings-in-chat + hosted-secret round-trips with live-LLM scenarios.
3. [Launcher widgets](../research/03-launcher-widgets.md) — keep the resting
   home sparse; respec the wallet to doctrine; remove seven non-MVP widgets;
   prove the sparse state with an e2e fixture.
4. [Onboarding, tutorial & help](../research/04-onboarding-tutorial-help.md) —
   resurrect the live e2e lane, automate the default cloud path on devices via
   the SIWE wallet, and add a liveness contract to every onboarding path.
5. [Chat window UX](../research/05-chat-window-ux.md) — lock the transcript to
   vertical scroll, add history pagination, wire search into the overlay, pulse
   the mic; protect the already-built gesture system.
6. [View↔chat integration](../research/06-views-chat-integration.md) — close the
   gap list: give every view mutation a semantic chat action so the view is a
   pure state renderer and voice-first works for free.
7. [Voice pipeline](../research/07-voice-pipeline.md) — benchmark cloud vs
   on-device per platform, wire web cloud ASR for real, un-hardcode the STT
   model, make the Railway services first-class, prove bidirectional voice e2e.
8. [Device testing pipeline](../research/08-device-testing-pipeline.md) — fix
   the Android stale-install bug, ship a fleet `devices:status` build-stamp
   check, one triage bundle per run, one-command physical-iPhone lane.
9. [Doc-driven development](../research/09-doc-driven-development.md) — the
   process this folder encodes: discussion → doc → board issues → PR with inline
   evidence → doc updated; retire `.github/issue-evidence/`.

## Acceptance bar

MVP done is **evidence-driven**, per [`AGENTS.md`](../../../../AGENTS.md):
a reviewer confirms each change works *without reading the code*, from artifacts
attached inline to the PR. "Tests pass" is not proof; "CI is green" is not
proof. Per workstream, done means:

1. **Personas** — the coverage gate
   (`check-lifeops-persona-catalog-coverage.mjs`) reads verified = target for
   A1/A2/B2/F1; child-voice, student-deadline, onboarding-journey, elderly
   week-1, and non-sleep-goal scenarios exist and pass with hand-read live-model
   trajectories and catalog `status` notes recording model + judge score.
2. **Chat widgets** — the connector form-link is gone (free-text fallback);
   date/time field types render; live-LLM trajectories show FORM emit→submit→use,
   CHOICE pick, `[CONFIG]` emission, and the settings + hosted-secret
   round-trips working, reviewed by hand.
3. **Launcher** — an e2e fixture asserts the healthy-quiet home shows exactly
   time/weather + wallet (+ notifications when present), each keeper self-hides,
   and the wallet shows BTC/SOL/ETH by default / top-3 held, refreshing.
4. **Onboarding** — a green scheduled `app-live-e2e.yml` run with reviewed
   artifacts (real cloud login + real-LLM reply); iOS-sim + Android-emu lanes
   that onboard through the real UI via the SIWE wallet and record MP4 + JPG;
   every onboarding path ends with one real chat turn asserting a non-stub
   reply.
5. **Chat UX** — a wheel/deltaX regression e2e proves vertical-only scroll;
   scroll-up pagination verified against the perf gate; search reachable on the
   overlay with a working jump; mic pulses on the primary surface; stale
   `chat-full-clear`/`-maximize` specs deleted.
6. **View↔chat** — a real-LLM scenario changes each targeted view's state
   ("turn on voice", "delete that document", "reset my background") *without* the
   model emitting a raw selector; a ratchet asserts every builtin view mutation
   maps to a registered action.
7. **Voice** — the cloud-vs-local benchmark table (TTFB, RTT, WER, sizes) is
   published inline with the web-TTS default decision recorded; one lane proves
   mic → STT → live agent → TTS → audible reply on web (Railway) and desktop
   (local) with an MP4-with-audio, including mic-denied / silence / network-drop
   failure paths.
8. **Device testing** — the Android runner reinstalls on stamp mismatch;
   `devices:status` reports installed buildId/commit per connected device vs
   develop HEAD; each device-e2e run emits one triage bundle (MP4 + JPG + logs +
   `summary.json` + `junit.xml`); the physical-iPhone lane is one command.
9. **Process** — this folder's README + MVP doc exist (the `markdown-links` lane
   is green), the PR-evidence gate no longer accepts retired issue-evidence
   paths, the discussions are open, and the board carries every MVP issue.
