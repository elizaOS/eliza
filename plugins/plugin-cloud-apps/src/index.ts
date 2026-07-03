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
 * Manage layer (edit / monetize / earnings / money-out / key rotation):
 *   - Action  UPDATE_APP            — rename / edit name, description, logo, website, email.
 *   - Action  UPDATE_MONETIZATION   — enable/disable + markup % / purchase share %; range-guarded.
 *   - Action  GET_APP_EARNINGS      — READ-ONLY: withdrawable / pending / lifetime / withdrawn.
 *   - Action  WITHDRAW_APP_EARNINGS — MONEY-OUT: two-phase confirm + dashboard CTA; the safe,
 *                                     idempotent, server-gated request endpoint fires on confirm;
 *                                     money/credentials NEVER transit the connector.
 *   - Action  REGENERATE_APP_API_KEY— SECURITY: two-phase confirm; new key shown ONCE, never logged.
 *
 * Domains layer (the last launch slice — check → buy → list):
 *   - Action  CHECK_APP_DOMAIN      — READ-ONLY availability + purchase/renewal price quote.
 *   - Action  BUY_APP_DOMAIN        — MONEY-OUT: read-only quote first, two-phase confirm with a
 *                                     15-minute quote TTL; maps the server's idempotent-buy /
 *                                     refund-on-registrar-failure / no-charge-recovery outcomes
 *                                     to honest replies; money never transits the connector.
 *   - Action  LIST_APP_DOMAINS      — READ-ONLY: registrar/status/SSL/verification per domain.
 *
 * Auth: reads `ELIZAOS_CLOUD_API_KEY` (+ optional `ELIZAOS_CLOUD_BASE_URL`) via
 * runtime settings — the same credentials plugin-elizacloud uses. With no key
 * the actions degrade gracefully and the provider stays EMPTY.
 *
 * NOTE: a real end-to-end deploy can't be verified until the staging deploy
 * backend is armed (#9853 / Phase 4). DEPLOY_APP's tests drive the completion
 * gate with a mocked status progression + reachability — that is the proof for now.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { Plugin } from "@elizaos/core";
import { getAdCampaignAttributionAction } from "./actions/ad-attribution.js";
import {
  duplicateAdCampaignAction,
  exportAdCampaignReportAction,
  setAdCampaignDaypartingAction,
} from "./actions/ad-campaigns.js";
import {
  createAdSlotAction,
  listAdSlotsAction,
} from "./actions/ad-inventory.js";
import { backupAppAction } from "./actions/backup-app.js";
import { bookInfluencerAction } from "./actions/book-influencer.js";
import { buyAppDomainAction } from "./actions/buy-app-domain.js";
import { checkAppDomainAction } from "./actions/check-app-domain.js";
import { createAppAction } from "./actions/create-app.js";
import { deleteAppAction } from "./actions/delete-app.js";
import { deployAppAction } from "./actions/deploy-app.js";
import { deployFrontendAction } from "./actions/deploy-frontend.js";
import { getAppAction } from "./actions/get-app.js";
import { getAppDeployStatusAction } from "./actions/get-app-deploy-status.js";
import { getAppEarningsAction } from "./actions/get-app-earnings.js";
import {
  createInfluencerProfileAction,
  listInfluencersAction,
} from "./actions/influencer.js";
import { listAppDomainsAction } from "./actions/list-app-domains.js";
import { listCloudAppsAction } from "./actions/list-cloud-apps.js";
import { regenerateAppApiKeyAction } from "./actions/regenerate-app-api-key.js";
import {
  listFrontendDeploymentsAction,
  rollbackFrontendAction,
} from "./actions/rollback-frontend.js";
import { updateAppAction } from "./actions/update-app.js";
import { updateMonetizationAction } from "./actions/update-monetization.js";
import { withdrawAppEarningsAction } from "./actions/withdraw-app-earnings.js";
import { cloudAppsProvider } from "./providers/cloud-apps.js";

export { getAdCampaignAttributionAction } from "./actions/ad-attribution.js";
export {
  duplicateAdCampaignAction,
  setAdCampaignDaypartingAction,
} from "./actions/ad-campaigns.js";
export {
  createAdSlotAction,
  listAdSlotsAction,
} from "./actions/ad-inventory.js";
export { backupAppAction } from "./actions/backup-app.js";
export { bookInfluencerAction } from "./actions/book-influencer.js";
export { buyAppDomainAction } from "./actions/buy-app-domain.js";
export { checkAppDomainAction } from "./actions/check-app-domain.js";
export { createAppAction } from "./actions/create-app.js";
export { deleteAppAction } from "./actions/delete-app.js";
export { deployAppAction } from "./actions/deploy-app.js";
export { deployFrontendAction } from "./actions/deploy-frontend.js";
export { getAppAction } from "./actions/get-app.js";
export { getAppDeployStatusAction } from "./actions/get-app-deploy-status.js";
export { getAppEarningsAction } from "./actions/get-app-earnings.js";
export {
  createInfluencerProfileAction,
  listInfluencersAction,
} from "./actions/influencer.js";
export { listAppDomainsAction } from "./actions/list-app-domains.js";
export { listCloudAppsAction } from "./actions/list-cloud-apps.js";
export { regenerateAppApiKeyAction } from "./actions/regenerate-app-api-key.js";
export {
  listFrontendDeploymentsAction,
  rollbackFrontendAction,
} from "./actions/rollback-frontend.js";
export { updateAppAction } from "./actions/update-app.js";
export { updateMonetizationAction } from "./actions/update-monetization.js";
export { withdrawAppEarningsAction } from "./actions/withdraw-app-earnings.js";
export * from "./app-facts.js";
export * from "./client.js";
export * from "./deploy-gate.js";
export * from "./domain-facts.js";
export * from "./domain-intent.js";
export { cloudAppsProvider } from "./providers/cloud-apps.js";
export * from "./reachability.js";
export * from "./safety.js";

export const cloudAppsPlugin: Plugin = {
  name: "cloud-apps",
  description:
    "Eliza Cloud Apps: list and describe the user's apps, create them, deploy them with a live-verification gate, check deploy status, safely delete them, and manage their custom domains (check, buy, list) — across every connector.",
  actions: [
    listCloudAppsAction,
    getAppAction,
    createAppAction,
    deployAppAction,
    deployFrontendAction,
    listFrontendDeploymentsAction,
    rollbackFrontendAction,
    getAppDeployStatusAction,
    deleteAppAction,
    updateAppAction,
    updateMonetizationAction,
    getAppEarningsAction,
    withdrawAppEarningsAction,
    regenerateAppApiKeyAction,
    getAdCampaignAttributionAction,
    createAdSlotAction,
    listAdSlotsAction,
    setAdCampaignDaypartingAction,
    duplicateAdCampaignAction,
    exportAdCampaignReportAction,
    createInfluencerProfileAction,
    listInfluencersAction,
    bookInfluencerAction,
    backupAppAction,
    checkAppDomainAction,
    buyAppDomainAction,
    listAppDomainsAction,
  ],
  providers: [cloudAppsProvider],
};

export default cloudAppsPlugin;
