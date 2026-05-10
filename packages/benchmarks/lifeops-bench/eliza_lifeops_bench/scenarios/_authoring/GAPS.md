# Action manifest gaps + Wave 4A rename reconciliation

Last updated: 2026-05-10 (Wave 4C reconciliation pass)

This file has two parts:

1. **RESOLVED — Wave 4A rename reconciliation.** Action names that the
   Wave 2A corpus referenced but Wave 4A renamed in the canonical
   manifest. All scenarios + the runner `_ACTION_HANDLERS` registry
   were updated; the rename mapping is recorded for future readers.
2. **Missing actions.** Capabilities the corpus wanted to express but
   couldn't because no action exists. Used as input for follow-up
   waves that add new actions to `app-lifeops` or new plugins.

---

## Part 1 — RESOLVED rename mapping (Wave 4A → corpus reconciled)

Wave 4A consolidated the legacy `PAYMENTS` / `SUBSCRIPTIONS_*` umbrella
into the `MONEY_*` family and the legacy `APP_BLOCK` / `WEBSITE_BLOCK`
pair into the `BLOCK_*` family. Param schemas are unchanged — only the
action names moved. Both umbrella verbs (`MONEY`, `BLOCK`) and the
specialized verbs (`MONEY_DASHBOARD`, `BLOCK_BLOCK`, …) are exposed in
the manifest; the corpus uses the specialized name when available, per
the convention recorded below in "Action-name discoverability."

### Rename mapping

| Old action name (Wave 2A) | New action name (Wave 4A manifest) | subaction kept | Notes |
|---|---|---|---|
| `PAYMENTS` (subaction=`dashboard`) | `MONEY_DASHBOARD` | `dashboard` | param schema identical (windowDays etc.) |
| `PAYMENTS` (subaction=`list_transactions`) | `MONEY_LIST_TRANSACTIONS` | `list_transactions` | param schema identical (merchantContains, windowDays, onlyDebits) |
| `SUBSCRIPTIONS_AUDIT` (subaction=`audit`) | `MONEY_SUBSCRIPTION_AUDIT` | `audit` | param schema identical (queryWindowDays) |
| `SUBSCRIPTIONS_CANCEL` (subaction=`cancel`) | `MONEY_SUBSCRIPTION_CANCEL` | `cancel` | param schema identical (serviceName, serviceSlug, confirmed) |
| `APP_BLOCK` (subaction=`block`) | `BLOCK_BLOCK` (with `packageNames`) | `block` | unified handler honors both packageNames + hostnames |
| `WEBSITE_BLOCK` (subaction=`block`) | `BLOCK_BLOCK` (with `hostnames`) | `block` | same as above |
| `WEBSITE_BLOCK` (subaction=`list_active`) | `BLOCK_LIST_ACTIVE` | `list_active` | includeLiveStatus + includeManagedRules retained |

### Files updated

- `eliza_lifeops_bench/scenarios/finance.py` — 5 scenarios (`PAYMENTS` ×3,
  `SUBSCRIPTIONS_AUDIT` ×1, `SUBSCRIPTIONS_CANCEL` ×1) renamed.
- `eliza_lifeops_bench/scenarios/focus.py` — 3 scenarios (`APP_BLOCK` ×1,
  `WEBSITE_BLOCK` ×2) renamed.
- `eliza_lifeops_bench/runner.py` — handler functions renamed
  (`_u_payments` → `_u_money_readonly`, `_u_subscriptions_audit` →
  `_u_money_subscription_audit`, `_u_subscriptions_cancel` →
  `_u_money_subscription_cancel`, `_u_app_block`/`_u_website_block` →
  `_u_block`). Dispatch registry expanded so every renamed verb (umbrella
  + specialized) routes to the right handler.
- `eliza_lifeops_bench/lifeworld/world.py` — docstring on
  `cancel_subscription` updated to point at the new action name.
- `LIFEOPS_BENCH_GAPS.md` — registry / no-op listing updated.

`tests/test_scenarios_corpus.py::test_every_action_name_exists_in_manifest`
now passes; full `pytest tests/` is green (575 passed, 3 skipped).

---

## Part 2 — Missing actions (gap analysis)

Capabilities the 53-static + 15-live scenario corpus wants that the
current Eliza action manifest does not expose. Each entry calls out the
proposed action surface, why it's needed, suggested home plugin, and
priority based on how many scenarios in the corpus would benefit.

Hard rule for this wave: **do not add the actions yet.** This list is
the input for Wave 4D (and downstream plugin-authoring waves) to decide
which gaps to close.

### Top 10 missing actions (ordered by scenario reach + value)

1. **`MAIL_BULK_ARCHIVE_BY_LABEL`** — high
   - Surface: `(label, source, olderThanDays?, dryRun?, confirmed?)`.
     Archives every thread matching a label/category in one call.
   - Why: `mail.triage_unread_inbox` and the
     `live.mail.triage_morning_inbox` flow both want a "archive every
     newsletter" verb. Today the agent has to enumerate threads and
     loop `MESSAGE/manage(archive, threadId)` per item, which both
     blows token budget and breaks the determinism contract.
   - Home: `app-lifeops` (extension on the `MESSAGE` family).

2. **`MAIL_FORWARD`** — high
   - Surface: `(messageId|threadId, to[], note?, includeAttachments?)`.
     Forward an existing email (or thread) to a contact list.
   - Why: triage flows often need "forward this to Hannah and Caleb";
     no action exists today. The agent can only `MESSAGE/draft_reply`
     to the original sender, not redirect.
   - Home: `app-lifeops` (`MESSAGE` family).

3. **`HEALTH_LOG_WORKOUT`** — high
   - Surface: `(activity, distanceKm?, durationMinutes, effort?,
     occurredAtIso?, heartRateAvg?, route?)`.
   - Why: `health.log_morning_run_workout` currently smuggles workout
     data through `LIFE_CREATE` with a free-form `details.kind=workout`
     payload — works, but loses schema validation and forces every
     adapter to remember the LIFE-as-workout convention. A typed
     workout action makes the write path testable.
   - Home: `app-lifeops` (extends the read-only `HEALTH` umbrella with
     a write verb), or a dedicated `app-fitness`.

4. **`HEALTH_LOG_METRIC`** — high
   - Surface: `(metric: enum[weight_kg|blood_pressure|...] , value,
     unit?, occurredAtIso?, source?)`.
   - Why: `health.log_weight_today` has the same problem as workout
     logging — currently piggybacking on `LIFE_CREATE`. A dedicated
     write-side action mirrors the existing read-side `HEALTH`
     subactions and removes the `details.kind=health_metric` dance.
   - Home: same as `HEALTH_LOG_WORKOUT`.

5. **`REMINDERS_LIST_OVERDUE`** — high
   - Surface: `(scope?: all|listId, asOfIso?, limit?)`.
   - Why: `reminders.list_overdue` and the live health/triage flows
     all need "what's overdue right now" but route through
     `LIFE_REVIEW`, which is a generic review verb whose returned
     payload mixes overdues, due-soon, snoozed, and recently-completed.
     A dedicated overdue-listing verb makes the agent's tool selection
     unambiguous.
   - Home: `app-lifeops`.

6. **`CALENDAR_FORWARD_INVITE`** — medium
   - Surface: `(eventId, calendarId, to[], note?)`. Forward an existing
     calendar event invite to additional attendees with optional note.
   - Why: live travel + cross-domain flows ("share this OOO with the
     team") fall back to `MESSAGE/send` with a copy-pasted summary.
     A native forward keeps the event linkage intact.
   - Home: `app-lifeops` (`CALENDAR` family).

7. **`CALENDAR_FIND_RECURRING_INSTANCE` /
   `CALENDAR_DELETE_INSTANCE`** — medium
   - Surface: `(eventId, occurrenceDate, scope: this|future|all)`.
     Find or cancel a single occurrence of a recurring event.
   - Why: `calendar.cancel_tentative_launch_checklist` currently works
     because the seeded event isn't recurring; any "skip just next
     week's standup" scenario can't be authored cleanly. The Wave 2A
     authoring notes flagged this as a real gap.
   - Home: `app-lifeops` (`CALENDAR` family).

8. **`TRAVEL_SEARCH_HOTEL` / `TRAVEL_BOOK_HOTEL`** — medium
   - Surface: `(city|coordinates, checkIn, checkOut, guests, priceMax?,
     amenities?[])` for search; `(offerId, paymentMethodId, confirmed)`
     for book.
   - Why: `live.travel.plan_nyc_trip_end_to_end` explicitly asks for
     "propose hotel options near midtown". `BOOK_TRAVEL` only covers
     flights, so the live agent must fake the hotel step as a message
     or skip it. Same logic applies for rental cars
     (`TRAVEL_SEARCH_CAR`).
   - Home: `app-lifeops` (extend `BOOK_TRAVEL`), or split into a new
     `app-travel` plugin.

9. **`MUSIC_*` family (PLAYLIST_LIST, PLAYLIST_ADD_TRACK, NOW_PLAYING,
   QUEUE_TRACK)** — medium
   - Surface: Spotify / Apple Music style. List playlists, add a track
     to a named playlist, fetch what's currently playing, queue a
     track on the active device.
   - Why: not in any current scenario, but a productivity assistant
     without music control is a notable gap given the user base. Adds
     a new domain for live scenarios (e.g. "play my focus playlist
     when I start a 25-minute block" — would compose with `BLOCK_*`).
   - Home: new `app-music` plugin (matches the existing `app-phone`
     pattern of one-plugin-per-platform-capability).

10. **`PLACES_DISCOVER` / `PLACES_DETAILS`** — low/medium
    - Surface: `(query|category, near?: address|coords, openNow?,
      priceLevel?, radiusMeters?, limit?)` and
      `(placeId, fields?)`.
    - Why: travel + dining scenarios consistently want "find a coffee
      shop near my hotel" or "what's open near 5th Ave". Today the
      agent has to fall back to web search via a `MESSAGE` summary.
      Fits naturally as a sibling of `BOOK_TRAVEL`.
    - Home: new `app-places` plugin or extension on `app-lifeops`.

### Additional gaps (lower-priority, single-scenario reach)

- **`RECIPE_*`** — multi-step recipe with timer integration. No
  scenarios author this today; called out in the original Wave 2A
  notes. Would compose `LIFE_CREATE(reminder)` + `SCHEDULED_TASK_*` +
  a new recipe entity. Suggested home: new `app-cooking` plugin.
- **`FOCUS_PRESET`** — composite preset that bundles `BLOCK_BLOCK` (apps
  + sites) + `SCHEDULED_TASK_CREATE` + `CALENDAR/create_event` for "deep
  work mode". Today every focus scenario assembles these manually.
  Suggested home: `app-lifeops`.
- **`CONTACTS_LIST_BY_RELATIONSHIP`** — listing only `family` /
  `friend` / `work` contacts currently uses `ENTITY/list` with a
  free-form `intent` string. A typed predicate would make
  `contacts.list_family_contacts` deterministic.
  Suggested home: `app-lifeops` (`ENTITY` family).
- **`CONTACTS_UPDATE_PHONE`** — currently goes through
  `ENTITY/set_identity` with `platform: "phone"`. A targeted verb
  would simplify the `contacts.update_phone_for_caleb_nguyen`
  authoring (no `platform` discriminator to remember).
- **`MAIL_LABEL_ADD` / `MAIL_LABEL_REMOVE`** — labeling is currently
  pushed through `MESSAGE/manage` with `manageOperation: "label_add"`.
  Dedicated verbs make the test path explicit.
- **`MESSAGE_DRAFT_NON_GMAIL`** — chat drafts on iMessage / WhatsApp
  / Slack are currently no-ops in the executor (see
  `LIFEOPS_BENCH_GAPS.md`). Promoting drafts to a real entity unblocks
  the live triage scenarios that want to draft + show before sending.
  Suggested home: extend `MESSAGE` umbrella; LifeWorld needs a
  `Draft` entity.
- **`TRAVEL_SHARE_ITINERARY`** — typed share that emits a structured
  itinerary payload (composes with calendar + partner messages).
  Today `travel.share_itinerary_via_imessage` uses a freeform
  `MESSAGE/send`. Suggested home: `app-lifeops` (`BOOK_TRAVEL` family).

### Action-name discoverability (carry-over from Wave 2A authoring)

Many actions are namespaced redundantly: the umbrella name (`LIFE`,
`MESSAGE`, `MONEY`, `BLOCK`) plus per-subaction specialized verbs
(`LIFE_CREATE`, `LIFE_COMPLETE`, `MONEY_DASHBOARD`, `BLOCK_BLOCK`).
That's fine for the planner — both names route to the same handler —
but makes scenario authoring noisy. Convention used in the corpus:
**prefer the specialized name when the manifest exposes it; fall back
to the umbrella + subaction when the specialized verb doesn't exist
yet** (e.g. `CALENDAR/search_events` has no `CALENDAR_SEARCH_EVENTS`
top-level entry as of 2026-05-10).

---

## Notes for follow-up waves

If a future wave decides to add any of the proposed actions:

1. Add the action definition under
   `plugins/app-lifeops/src/actions/<name>.ts` (or in the right new
   plugin).
2. Re-export the manifest:
   `bun run scripts/lifeops-bench/export-action-manifest.ts`.
3. Author the scenario(s) the gap blocked above and remove the entry
   from this file.
4. If the new action mutates a LifeWorld entity that doesn't exist
   yet (e.g. a `FocusBlock`, `Draft`, or `Place`), add the entity to
   `eliza_lifeops_bench/lifeworld/entities.py` so state-hash scoring
   can verify the mutation actually happened.
5. Wire the new action into `_ACTION_HANDLERS` in
   `eliza_lifeops_bench/runner.py` so the executor dispatch can apply
   it against the world.
