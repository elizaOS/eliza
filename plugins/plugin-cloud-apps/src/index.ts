/**
 * @elizaos/plugin-cloud-apps
 *
 * Lets an Eliza agent answer questions about the user's Eliza Cloud Apps —
 * "what apps do I have?" and "tell me about app X" — from a single plugin
 * registration that reaches every connector (in-app, Discord, Telegram, and
 * cloud-hosted) through the shared AgentRuntime pipeline.
 *
 * This is the READ-CORE: it ships only non-mutating capabilities.
 *
 *   - Action  LIST_CLOUD_APPS — list the user's apps (name / url / status).
 *   - Action  GET_APP         — details for one app by name or id.
 *   - Provider CLOUD_APPS     — injects the app inventory into planner context.
 *
 * Auth: reads `ELIZAOS_CLOUD_API_KEY` (+ optional `ELIZAOS_CLOUD_BASE_URL`) via
 * runtime settings — the same credentials plugin-elizacloud uses. With no key
 * the actions degrade gracefully and the provider stays EMPTY.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEFERRED to Phase 3b (mutating / money actions — intentionally NOT here):
 *   - CREATE_APP
 *   - UPDATE_APP
 *   - UPDATE_MONETIZATION
 *   - DEPLOY_APP
 *   - GET_APP_DEPLOY_STATUS
 *   - DELETE_APP
 *   - GET_APP_EARNINGS
 *   - WITHDRAW_APP_EARNINGS
 *   - REGENERATE_APP_API_KEY
 *   - BUY_APP_DOMAIN
 * Those require the confirm/CTA pattern and a facts/knowledge cache, and they
 * move real money — they ship on a later, separately-reviewed branch. The typed
 * SDK methods (`client.createApp`, `client.deployApp`, …) already exist on the
 * base branch; only the agent-facing actions are deferred.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { Plugin } from "@elizaos/core";
import { getAppAction } from "./actions/get-app.js";
import { listCloudAppsAction } from "./actions/list-cloud-apps.js";
import { cloudAppsProvider } from "./providers/cloud-apps.js";

export { getAppAction } from "./actions/get-app.js";
export { listCloudAppsAction } from "./actions/list-cloud-apps.js";
export * from "./client.js";
export { cloudAppsProvider } from "./providers/cloud-apps.js";

export const cloudAppsPlugin: Plugin = {
  name: "cloud-apps",
  description:
    "Read-core for Eliza Cloud Apps: list the user's apps and describe a single app, across every connector.",
  actions: [listCloudAppsAction, getAppAction],
  providers: [cloudAppsProvider],
};

export default cloudAppsPlugin;
