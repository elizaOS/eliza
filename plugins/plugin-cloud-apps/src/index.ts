/**
 * @elizaos/plugin-cloud-apps
 *
 * Lets an Eliza agent manage the user's Eliza Cloud Apps — list them, describe
 * one, and run the create → deploy → live loop — from a single plugin
 * registration that reaches every connector (in-app, Discord, Telegram, and
 * cloud-hosted) through the shared AgentRuntime pipeline.
 *
 * Read-core (non-mutating):
 *   - Action  LIST_CLOUD_APPS       — list the user's apps (name / url / status).
 *   - Action  GET_APP               — details for one app by name or id.
 *   - Provider CLOUD_APPS           — injects the app inventory into planner context.
 *
 * Create → deploy → live loop + safe delete (this layer):
 *   - Action  CREATE_APP            — create an app from name/description/monetization intent.
 *   - Action  DEPLOY_APP            — deploy + COMPLETION GATE (READY status, then
 *                                     probe production_url `/health` for 2xx before
 *                                     claiming live) + idempotent facts cache.
 *   - Action  GET_APP_DEPLOY_STATUS — report DRAFT/BUILDING/DEPLOYING/READY/ERROR + url.
 *   - Action  DELETE_APP            — DESTRUCTIVE: two-phase, connector-agnostic confirm.
 *
 * Auth: reads `ELIZAOS_CLOUD_API_KEY` (+ optional `ELIZAOS_CLOUD_BASE_URL`) via
 * runtime settings — the same credentials plugin-elizacloud uses. With no key
 * the actions degrade gracefully and the provider stays EMPTY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEFERRED to Phase 3c (paid / CTA-bearing / last-mile — intentionally NOT here):
 *   - UPDATE_APP
 *   - UPDATE_MONETIZATION
 *   - GET_APP_EARNINGS
 *   - WITHDRAW_APP_EARNINGS   (paid → reuse the `buildConnectorCta` seam in safety.ts)
 *   - REGENERATE_APP_API_KEY
 *   - BUY_APP_DOMAIN          (domain is the last slice; SDK envelope not finalized)
 * The paid actions reuse the two-phase-confirm + connector CTA helper already
 * built here (`src/safety.ts`); money/credentials never transit the connector.
 *
 * NOTE: a real end-to-end deploy can't be verified until the staging deploy
 * backend is armed (#9853 / Phase 4). DEPLOY_APP's tests drive the completion
 * gate with a mocked status progression + reachability — that is the proof for now.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { Plugin } from "@elizaos/core";
import { createAppAction } from "./actions/create-app.js";
import { deleteAppAction } from "./actions/delete-app.js";
import { deployAppAction } from "./actions/deploy-app.js";
import { getAppAction } from "./actions/get-app.js";
import { getAppDeployStatusAction } from "./actions/get-app-deploy-status.js";
import { listCloudAppsAction } from "./actions/list-cloud-apps.js";
import { cloudAppsProvider } from "./providers/cloud-apps.js";

export { createAppAction } from "./actions/create-app.js";
export { deleteAppAction } from "./actions/delete-app.js";
export { deployAppAction } from "./actions/deploy-app.js";
export { getAppAction } from "./actions/get-app.js";
export { getAppDeployStatusAction } from "./actions/get-app-deploy-status.js";
export { listCloudAppsAction } from "./actions/list-cloud-apps.js";
export * from "./app-facts.js";
export * from "./client.js";
export * from "./deploy-gate.js";
export { cloudAppsProvider } from "./providers/cloud-apps.js";
export * from "./reachability.js";
export * from "./safety.js";

export const cloudAppsPlugin: Plugin = {
  name: "cloud-apps",
  description:
    "Eliza Cloud Apps: list and describe the user's apps, create them, deploy them with a live-verification gate, check deploy status, and safely delete them — across every connector.",
  actions: [
    listCloudAppsAction,
    getAppAction,
    createAppAction,
    deployAppAction,
    getAppDeployStatusAction,
    deleteAppAction,
  ],
  providers: [cloudAppsProvider],
};

export default cloudAppsPlugin;
