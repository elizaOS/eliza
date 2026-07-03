# #11632 — LifeOps Live Test (HITL) — evidence

The new `/lifeops-live-test` view (hosted in `@elizaos/plugin-scheduling`) turns the
LifeOps live-validation runbook (`plugins/plugin-personal-assistant/docs/LIFEOPS_LIVE_VALIDATION.md`)
into a clickable HITL surface: connect your model + accounts, then run a **real**
schedule → fire → dispatch and watch the outcome. No `.env` editing, no vitest.

Captured against a live dev stack (injected login), desktop 1440×900 + mobile 390×844,
0 console errors. `/api/views` served the bundle (`available:true`, `componentExport:"LifeOpsLiveTestView"`).

| File | What it shows |
| --- | --- |
| `desktop-rest.png` | Rest state — readiness checklist (AI model **connected ✓**; Google/Telegram/Discord/Slack/X connectors each with a **Connect** action), the **Run live validation** / **Run check-in probe** buttons, and the empty scheduled-tasks state. |
| `mobile-rest.png` | Same view at mobile width — stacks cleanly, buttons readable, brand-compliant. |
| `desktop-after-run.png` | After clicking **Run live validation**: the `test-probe` seeded a due-now reminder and fired it → **"Fired — The scheduler fired the reminder and dispatched it to you."**, the task appears under **Recent scheduled tasks (1)** with a per-row **Fire now** button, and a **real reminder notification toast** fires at the bottom — proof the end-to-end live dispatch path ran. |

**Brand:** orange accent only, no blue; orange-resting → darker-orange hover via the
`@elizaos/ui/spatial` primitives' semantic `tone=` (no hardcoded colors). Audit
(`bun run --cwd packages/app audit:app -- --grep lifeops-live-test`): 8/8 good,
broken=0, needs-work=0.

**Backend proof:** `plugins/plugin-scheduling` full suite 230/230 green, including 4 new
route tests for `POST …/:id/fire` and `POST …/test-probe` (happy path, unknown-id
never-false-`fired`, seed+fire, check-in variant).
