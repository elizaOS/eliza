# #9450 — single-implementation invariant audit

Exactly one canonical implementation of each home/launch surface on `develop`. No second versions found or introduced.

| Surface | Single implementation | Notes |
|---|---|---|
| Launcher | `packages/ui/src/components/pages/Springboard.tsx` | iOS-like grid + favorites dock + edit mode. `SpringboardSurface.tsx` is a **wrapper** (filter/merge of routable views + catalog), not a duplicate launcher. The old `ViewCatalog.tsx` / `ViewsPage` / shell `Springboard.tsx` no longer exist. |
| Home | `packages/ui/src/components/shell/HomeScreen.tsx` | Mounts `WidgetHost slot="home"`. |
| Home ↔ Springboard composition | `packages/ui/src/components/shell/HomeSpringboardSurface.tsx` | Unified onto a single `shell-surface-store` (`useShellSurface`, `goHome`/`goSpringboard`, `setSpringboardPage`, `springboardEditing`) so the surface, inner pager, edit mode, and the single page indicator cannot disagree. `touch-pan-y` reserves vertical scroll while claiming horizontal flicks. |
| Onboarding (ui) | `packages/ui/src/first-run/CompactOnboarding.tsx` + `use-first-run-controller.ts` | Single ui-onboarding. Desktop `FirstRunScreen` (in `app-core`) is the single desktop variant, not a second `@elizaos/ui` onboarding. |
| Widget registry | `packages/ui/src/widgets/registry.ts` + `WidgetHost.tsx` | Single registry + host; per-plugin declarations + `defaultWidget` sink. |

## Dead-code removal (verified on `develop`)
- `WidgetSlot` pruned to `chat-sidebar \| character \| nav-page \| home` (const `WIDGET_SLOTS`); `chat-inline`, `wallet`, `browser`, `heartbeats`, `settings`, `automations` removed (PR #9513). Empty `heartbeats` `WidgetHost` mount removed.
- core↔ui divergence guard: `packages/ui/src/widgets/types.test.ts` "WidgetSlot contract — stays aligned with core PluginWidgetDeclaration".
- `WIDGET_MATRIX.md` updated with the post-cleanup slot inventory (`nav-page` retained as the active app-navigation contract — intentional, no mount).
- `HIDDEN_SPRINGBOARD_VIEW_IDS` = `{chat, views, apps, views-manager, character, character-select, voice}` — all are routing-artifact filters (the home itself / self-links / non-tile surfaces), not stale; retained intentionally.

## Live notification path (no longer dead)
`"notification"` ∈ `AGENT_EVENT_ALLOWED_STREAMS` (`plugin-discovery-helpers.ts:750`). Proven by `misc-routes.agent-event.test.ts` (server) + `notification-store.test.ts` (client WS ingest) — see the `9448` evidence logs.

## Intentional e2e stubs (NOT dead code)
`home-screen-fixture.*-stub.ts(x)` / `widgethost-stub.tsx` remain the only stubs — documented test doubles because the real `WidgetHost` pulls Node-only services; real behavior is covered by `WidgetHost.test.tsx` / `home-rank` tests + the live `run-home-screen-e2e.mjs`.
