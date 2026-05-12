# Capability Taxonomy — Standardized Action Tags

**Status:** Canonical reference for Wave 4D (`AGENTS.md` standards #2, #4, #7, #8).
**Owners:** LifeOps actions surface (`plugins/app-lifeops/src/actions/`),
exporter (`scripts/lifeops-bench/export-action-manifest.ts`), benchmark
scenario corpus (`packages/benchmarks/lifeops-bench/`).

Every life-relevant Eliza Action carries a small, machine-checkable set of
tags so external harnesses can filter the surface by **what the action does**,
**where it does it**, and **how dangerous it is**. The four tag categories
are mutually orthogonal — a single action carries one domain tag, one or more
capability tags, one or more surface tags, and zero or one risk tag.

The exporter (`bun run scripts/lifeops-bench/export-action-manifest.ts`)
validates the taxonomy on every run with `--validate-taxonomy` and supports
filter flags (`--domain`, `--capability`, `--surface`, `--exclude-risk`)
backed by the same vocabulary defined here.

## 1. Domain tags (exactly one per action — primary life domain)

| Tag                  | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `domain:calendar`    | Calendars, events, availability, meeting prefs, scheduling.             |
| `domain:mail`        | Email inboxes (Gmail, IMAP).                                            |
| `domain:messages`    | Synchronous chat / DMs / SMS / IM (iMessage, Discord, Telegram).        |
| `domain:contacts`    | People, orgs, projects, relationships, follow-up cadence.               |
| `domain:reminders`   | Reminders, todos, scheduled tasks, recap/follow-up scheduling.          |
| `domain:notes`       | Notes, knowledge capture (Apple Notes, Obsidian, Notion).               |
| `domain:finance`     | Money: payments, transactions, subscriptions, charges.                  |
| `domain:travel`      | Flights, hotels, trip booking, travel itinerary.                        |
| `domain:health`      | Health/fitness telemetry (sleep, steps, heart rate, workouts).          |
| `domain:sleep`       | Sleep-specific routines and policies (when separate from `health`).     |
| `domain:focus`       | App/website blocking, screen-time, focus blocks.                        |
| `domain:home`        | Home automation, smart-home devices.                                    |
| `domain:music`       | Music control, playback, playlists.                                     |
| `domain:entity`      | Entity/relationship CRUD that is not contacts-shaped (rarely needed).   |
| `domain:meta`        | LifeOps housekeeping: pause, toggle-feature, profile, first-run, etc.  |

Each action is tagged with the **one** domain that best names its primary
purpose. When an umbrella legitimately spans multiple domains, pick the
dominant one and use additional capability tags to express the rest.

## 2. Capability tags (one or more — what the action lets the agent do)

| Tag                    | Meaning                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `capability:read`      | Read-only — no state mutation anywhere.                       |
| `capability:write`     | Creates new state (an event, a draft, a contact, a rule).     |
| `capability:update`    | Modifies existing state.                                      |
| `capability:delete`    | Removes state.                                                |
| `capability:send`      | Emits a message externally (mail, sms, im).                   |
| `capability:schedule`  | Schedules a future action (reminder, follow-up, snooze).      |
| `capability:execute`   | Runs a side-effecting operation (place call, charge a card, block an app, dispatch a notification, browser-cancel a sub). |

Multiple capability tags are normal. A "draft + send" action carries
`capability:write` AND `capability:send`. A "create + update + delete"
umbrella carries all three. `capability:read` should not coexist with any
mutating capability — split or rescope the umbrella if you find a conflict.

## 3. Surface tags (one or more — where the action touches state)

| Tag                       | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `surface:remote-api`      | Hits a third-party API (Gmail, Plaid, Calendly, Twilio, …).     |
| `surface:device`          | Touches the local device (notifications, blockers, screen-time).|
| `surface:internal`        | Pure LifeOps state (life, schedule, lifeops-pause).             |
| `surface:eliza-cloud`     | Touches Eliza Cloud directly.                                   |

Multiple surface tags are normal — e.g. CALENDAR is `surface:remote-api`
(Google Calendar) AND `surface:internal` (cached preferences).

## 4. Risk tags (zero or one — flags need-extra-confirmation)

| Tag                   | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `risk:irreversible`   | Once executed, no undo (sent message, cancelled subscription, booked flight, deleted record). |
| `risk:financial`      | Moves money or initiates a charge.                                 |
| `risk:user-visible`   | Externally visible to a third party (sends a message, posts on social, places a call). |

A single action carries **at most one** risk tag. When several apply, pick
the most severe (`financial > irreversible > user-visible`). Sandboxed test
harnesses should default to `--exclude-risk irreversible --exclude-risk
financial --exclude-risk user-visible` for the safest read-only catalogue.

## 5. Cost / latency hints (optional)

| Tag                | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `cost:cheap`       | Quick read against in-process state.                   |
| `cost:expensive`   | Slow or expensive (flight search, Plaid sync, browser executor). |

These are advisory only and may be omitted.

## 6. Migration rules

- The taxonomy is **breaking** for any caller that filtered on the old
  ad-hoc tags (e.g. `"always-include"`, `"meeting slots"`, `"call doctor"`).
  Production code does not consume those tags — only the exporter's `--tag`
  flag does, and that flag continues to work against the new taxonomy.
- When updating an action, **replace** legacy tags with canonical taxonomy
  values rather than appending. Promoted sub-actions inherit the parent's
  tags via `promoteSubactionsToActions` in `packages/core/src/actions/promote-subactions.ts`,
  so updating the umbrella propagates automatically.
- Run `bun run scripts/lifeops-bench/export-action-manifest.ts --validate-taxonomy`
  after every action edit. CI should fail if violations creep back in.

## 7. Edge cases discovered during the rollout

- **Umbrellas that fan out to multiple domains** (e.g. CALENDAR which also
  exposes meeting-pref preferences) — pick the dominant domain (`calendar`)
  and rely on the planner's umbrella expansion to handle nested calls.
- **MESSAGE** spans mail + chat + sms + social. Tag it `domain:messages`
  and rely on its own `source` parameter to disambiguate within the
  handler. Do not split it into one virtual action per provider.
- **CONNECTOR** is `domain:meta` (it manages connector lifecycle, not a
  domain), surfaces are `surface:remote-api` + `surface:internal`.
- **TODO** (plugin-todos) is `domain:reminders`, `surface:internal`.
- **PLACE_CALL** (app-phone) is `domain:meta` (raw Telecom dial; the
  policy-aware path is VOICE_CALL under `domain:meta`).
- **VOICE_CALL** is `domain:meta` because it is the LifeOps-policy-aware
  call dispatcher — the act of placing a call is `surface:remote-api` +
  `risk:user-visible`.
- **HEALTH** maps to `domain:health` and read-only `capability:read`
  (today's surface only queries telemetry; no writes).
- **SLEEP** is not a separate top-level Eliza action today; sleep policy
  lives under LIFE / UPDATE_MEETING_PREFERENCES. The taxonomy reserves
  `domain:sleep` for future actions and we will not currently apply it.
- **NOTES, HOME, MUSIC** are reserved domains for future plugin work; no
  current action maps to them.

## 8. Reference: planner-flagged "must-confirm" actions

The following actions carry `risk:irreversible` and SHOULD trigger a
confirmation gate in any harness that processes them:

- `MESSAGE` (when `op=send`) — drives `risk:irreversible` via the umbrella tag
- `BLOCK` / `BLOCK_BLOCK` — applies a focus block on the device
- `MONEY` / `MONEY_SUBSCRIPTION_CANCEL` — cancels a subscription
- `BOOK_TRAVEL` — books a flight or hotel (also `risk:financial`)
- `VOICE_CALL` / `VOICE_CALL_DIAL` — dials a person (also `risk:user-visible`)
- `LIFEOPS` (when `verb=wipe`) — destructive reset
- `CREDENTIALS` (when `subaction=inject_*`) — copies secrets to clipboard

The umbrella inherits the most severe risk that any of its subactions can
trigger, so consumers can filter at the umbrella level without enumerating
every subaction. When this is too coarse, the bench's `taxonomy.py` exposes
per-subaction overrides.
