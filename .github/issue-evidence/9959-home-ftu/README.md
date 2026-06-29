# #9959 — home FTU state + sunset lifecycle + orphaned-widget removal

Adds the missing **show-once-then-sunset** primitive the home widget layer
lacked, builds the first-time-user welcome card on top of it, and removes the
350 LOC of orphaned connector-nudge widgets that were ripped out because there
was no graceful fade model.

## What changed

- **`widgets/home-dismissal-store.ts`** (new) — persisted per-widget lifecycle
  (`seen` sessions / `acted` / `dismissed`), keyed by `homeWidgetKey`,
  `localStorage: eliza:home-dismissed:v1`. Mirrors `home-attention-store.ts`.
  `isHomeWidgetSunset(key, policy, state)` turns a widget's `sunset` policy into a
  retire decision.
- **`widgets/types.ts`** — new `HomeWidgetSunset` (`afterSeen` / `afterAction` /
  `dismissible`) + `sunset?` on the home widget declaration.
- **`widgets/WidgetHost.tsx`** — the `slot === "home"` branch filters out a
  sunset widget once `isHomeWidgetSunset` is true (subscribes to the store).
- **`widgets/home-priority.ts`** — new `welcome` signal kind, weight **8**:
  outranks every cold widget but stays BELOW `approval` (9) / `escalation` /
  `blocked` (10) — so a real "act now" signal always wins.
- **`components/chat/widgets/ftu-welcome.tsx`** (new) — `FtuWelcomeHomeWidget`:
  greeting + tappable `usePromptSuggestions` chips (dispatch into chat) + a
  dismiss control. `sunset: { afterAction: true, dismissible: true }`,
  high base order, self-publishes the `welcome` weight. Registered always-visible
  in `registry.ts`.
- **Deleted** `connectors-status.tsx` + `discord-recent.tsx` + their tests
  (350 LOC, confirmed unreachable — not referenced by `registry.ts` or anything
  but their own tests).
- **`widgets/HOME_CONTENT_TAXONOMY.md`** (new) — the four home content tiers, the
  sunset lifecycle, the `welcome` kind, and the `messages.recent` decision
  (kept: it's a launcher into past threads, not a live chat echo).

## Evidence (regenerate: `bun run --cwd packages/ui test:ftu-home-e2e`)

The e2e mounts the real FTU widget behind a faithful copy of WidgetHost's sunset
gate and drives the whole lifecycle (0 page errors):

| step | result |
|------|--------|
| cold home | welcome card + 3 chips visible — `01-desktop-cold.png`, `03-mobile-cold.png` |
| tap a chip | chat prefilled (`eliza:chat:prefill` captured) **and** card retired — `02-desktop-retired.png`, `04-mobile-retired.png` |
| reload | card stays retired (persisted in localStorage) |
| dismiss control | retires the card on its own |

`ftu-lifecycle-mobile.webm` — cold → tap chip → retired walkthrough.

## Tests
- `widgets/home-dismissal-store.test.ts` — the predicate (all sunset modes) +
  once-per-session seen counting + persistence + corrupt-value safety.
- `components/chat/widgets/ftu-welcome.test.tsx` — off-home renders nothing; chip
  tap prefills + marks acted; dismiss retires; `message_sent` event retires; the
  declared sunset policy.
- `WidgetHost` + `widget-coverage` + `registry.home` regression suites — pass.
- `bun run --cwd packages/ui typecheck` — PASS.

**Real-LLM trajectory / audio:** N/A — presentation-layer lifecycle; the
suggestions hook already has a deterministic fallback.
