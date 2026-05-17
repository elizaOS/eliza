# Cloud frontend component migration plan

## Direction

Move reusable UI out of `packages/cloud-frontend` and into `packages/ui`.
Cloud route files should become data/auth/mutation adapters that compose shared UI
components. Every shared component should have an entry in `packages/ui-stories`.

## Done in the current tree

- Dashboard composites in `packages/ui/src/cloud-ui/components/dashboard/cloud-dashboard-components.tsx`:
  - `DashboardActionCards`
  - `DashboardActionCardsSkeleton`
  - `AppsEmptyState`
  - `AppsSkeleton`
  - `ContainersEmptyState`
  - `ContainersSkeleton`
- UI exports updated through `cloud-ui/components/primitives.ts` and `components/index.ts`.
- Cloud routes import these composites from `@elizaos/ui`.
- `packages/ui-stories/src/stories/cloud-dashboard.tsx` covers the migrated dashboard composites across cloud, OS, and app themes.

## What should move next

- Entity tables:
  - `apps-table.tsx`
  - `containers-table.tsx`
  - `eliza-agents-table.tsx`
  - `api-keys-table.tsx`
  - Split into reusable table shell, column actions, status cells, and route-specific column config.
- Page wrappers:
  - `dashboard-page-wrapper.tsx`
  - `apps-page-wrapper.tsx`
  - `containers-page-wrapper.tsx`
  - `eliza-agents-page-wrapper.tsx`
  - `billing-page-wrapper.tsx`
  - `settings-page-client.tsx` shell pieces
  - Move visual wrappers to UI; keep data clients in Cloud.
- Settings connection panels:
  - Google, Microsoft, Discord gateway, Telegram, Twilio, WhatsApp, Blooio.
  - Consolidate onto `ConnectionCard` plus one `ConnectionPanel` composite.
- Analytics cards and charts:
  - `usage-chart.tsx`
  - `model-breakdown.tsx`
  - `provider-breakdown.tsx`
  - `projections-chart.tsx`
  - `cost-alerts.tsx`
  - `cost-insights-card.tsx`
  - Move chart shells, empty states, and legends. Keep query normalization in Cloud.
- Dialog shells:
  - `create-app-dialog.tsx`
  - `create-eliza-agent-dialog.tsx`
  - `withdraw-dialog.tsx`
  - `invite-member-dialog.tsx`
  - Move form layout and dialog chrome first; keep submit handlers and schemas local until APIs stabilize.
- Log/metrics surfaces:
  - `container-logs-viewer.tsx`
  - `docker-logs-viewer.tsx`
  - `eliza-agent-logs-viewer.tsx`
  - `container-metrics.tsx`
  - Consolidate on shared `LogViewer` and chart components.

## What should not move verbatim

- Hooks that call Cloud APIs.
- Query/mutation orchestration.
- `Helmet`, route params, redirects, auth guards, toasts, and one-time token consumers.
- Provider-specific payment/wallet implementation details.

## Story structure

- Keep `packages/ui-stories` as the current visual catalog.
- Add one story group per shared component family:
  - `Brand`
  - `Cloud Dashboard`
  - `Data Lists`
  - `Connection Panels`
  - `Analytics`
  - `Dialogs and Forms`
  - `AI Chat`
- Each story should render across `theme-cloud`, `theme-os`, and `theme-app`.
