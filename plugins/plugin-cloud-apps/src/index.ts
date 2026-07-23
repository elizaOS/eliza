/**
 * Cloud Apps lifecycle plugin for connector-driven app management.
 *
 * The registration lets an Eliza agent list, inspect, create, deploy, monetize,
 * back up, and safely mutate the user's Eliza Cloud Apps from every connector
 * surface through the shared AgentRuntime pipeline.
 *
 * Read-core (non-mutating):
 *   - Action  LIST_CLOUD_APPS       — list the user's apps (name / url / status).
 *   - Action  GET_APP               — details for one app by name or id.
 *   - Action  GET_PUBLISHED_PROJECT — project-bound live status + URL + analytics/earnings.
 *   - Action  GET_APP_ANALYTICS     — aggregate analytics for a published project.
 *   - Action  LIST_APP_USERS        — privacy-safe user list for a published project.
 *   - Action  GET_APP_DOMAIN_STATUS — live status for one attached domain.
 *   - Provider CLOUD_APPS           — injects the app inventory into planner context.
 *
 * Create → deploy → live loop + safe delete (this layer):
 *   - Action  PUBLISH_PROJECT       — create/reuse + bind, deploy, prove live, activate.
 *   - Action  UNPUBLISH_PROJECT     — confirm, deactivate, keep record + binding.
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
 * Domains layer:
 *   - Action  SEARCH_DOMAINS        — READ-ONLY priced registrar keyword search.
 *   - Action  LIST_MANAGED_DOMAINS — READ-ONLY organization-wide inventory.
 *   - Action  CHECK_APP_DOMAIN      — READ-ONLY availability + purchase/renewal price quote.
 *   - Action  BUY_APP_DOMAIN        — MONEY-OUT: read-only quote first, two-phase confirm with a
 *                                     15-minute quote TTL; maps the server's idempotent-buy /
 *                                     refund-on-registrar-failure / no-charge-recovery outcomes
 *                                     to honest replies; money never transits the connector.
 *   - Action  LIST_APP_DOMAINS      — READ-ONLY: registrar/status/SSL/verification per domain.
 *   - Action  GET_APP_DOMAIN_STATUS — READ-ONLY registrar and SSL status for one domain.
 *   - Action  LIST_DOMAIN_DNS_RECORDS — READ-ONLY managed DNS for one project domain.
 *
 * Auth uses `ELIZAOS_CLOUD_API_KEY` plus optional `ELIZAOS_CLOUD_BASE_URL` from
 * runtime settings, matching plugin-elizacloud credentials. Without a key,
 * actions decline gracefully and the provider stays empty.
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
import { getAppAnalyticsAction } from "./actions/get-app-analytics.js";
import { getAppDeployStatusAction } from "./actions/get-app-deploy-status.js";
import { getAppDomainStatusAction } from "./actions/get-app-domain-status.js";
import { getAppEarningsAction } from "./actions/get-app-earnings.js";
import { getPublishedProjectAction } from "./actions/get-published-project.js";
import {
  createInfluencerProfileAction,
  listInfluencersAction,
} from "./actions/influencer.js";
import { listAppDomainsAction } from "./actions/list-app-domains.js";
import { listAppUsersAction } from "./actions/list-app-users.js";
import { listCloudAppsAction } from "./actions/list-cloud-apps.js";
import { listDomainDnsRecordsAction } from "./actions/list-domain-dns-records.js";
import { listManagedDomainsAction } from "./actions/list-managed-domains.js";
import {
  draftPressReleaseAction,
  listPressReleasesAction,
  submitPressReleaseAction,
} from "./actions/press-releases.js";
import { publishProjectAction } from "./actions/publish-project.js";
import { regenerateAppApiKeyAction } from "./actions/regenerate-app-api-key.js";
import {
  listFrontendDeploymentsAction,
  rollbackFrontendAction,
} from "./actions/rollback-frontend.js";
import { searchDomainsAction } from "./actions/search-domains.js";
import { unpublishProjectAction } from "./actions/unpublish-project.js";
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
export { getAppAnalyticsAction } from "./actions/get-app-analytics.js";
export { getAppDeployStatusAction } from "./actions/get-app-deploy-status.js";
export { getAppDomainStatusAction } from "./actions/get-app-domain-status.js";
export { getAppEarningsAction } from "./actions/get-app-earnings.js";
export { getPublishedProjectAction } from "./actions/get-published-project.js";
export {
  createInfluencerProfileAction,
  listInfluencersAction,
} from "./actions/influencer.js";
export { listAppDomainsAction } from "./actions/list-app-domains.js";
export { listAppUsersAction } from "./actions/list-app-users.js";
export { listCloudAppsAction } from "./actions/list-cloud-apps.js";
export { listDomainDnsRecordsAction } from "./actions/list-domain-dns-records.js";
export { listManagedDomainsAction } from "./actions/list-managed-domains.js";
export {
  draftPressReleaseAction,
  listPressReleasesAction,
  submitPressReleaseAction,
} from "./actions/press-releases.js";
export { publishProjectAction } from "./actions/publish-project.js";
export { regenerateAppApiKeyAction } from "./actions/regenerate-app-api-key.js";
export {
  listFrontendDeploymentsAction,
  rollbackFrontendAction,
} from "./actions/rollback-frontend.js";
export { searchDomainsAction } from "./actions/search-domains.js";
export { unpublishProjectAction } from "./actions/unpublish-project.js";
export { updateAppAction } from "./actions/update-app.js";
export { updateMonetizationAction } from "./actions/update-monetization.js";
export { withdrawAppEarningsAction } from "./actions/withdraw-app-earnings.js";
export * from "./app-facts.js";
export * from "./client.js";
export * from "./deploy-gate.js";
export * from "./domain-facts.js";
export * from "./domain-intent.js";
export * from "./project-resolution.js";
export { cloudAppsProvider } from "./providers/cloud-apps.js";
export * from "./reachability.js";
export * from "./safety.js";

export const cloudAppsPlugin: Plugin = {
  name: "cloud-apps",
  description:
    "Publish and manage local Projects through Eliza Cloud apps: bind, deploy with liveness proof, inspect analytics/users/earnings, unpublish safely, and manage the underlying Cloud protocol resources.",
  actions: [
    listCloudAppsAction,
    getAppAction,
    getPublishedProjectAction,
    getAppAnalyticsAction,
    listAppUsersAction,
    createAppAction,
    publishProjectAction,
    unpublishProjectAction,
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
    draftPressReleaseAction,
    listPressReleasesAction,
    submitPressReleaseAction,
    backupAppAction,
    searchDomainsAction,
    listManagedDomainsAction,
    checkAppDomainAction,
    buyAppDomainAction,
    listAppDomainsAction,
    getAppDomainStatusAction,
    listDomainDnsRecordsAction,
  ],
  providers: [cloudAppsProvider],
};

export default cloudAppsPlugin;
