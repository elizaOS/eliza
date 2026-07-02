/**
 * Shared test helpers for plugin-cloud-apps.
 *
 * Only the SDK client is mocked: {@link FakeElizaCloudClient} stands in for
 * `@elizaos/cloud-sdk`'s `ElizaCloudClient`, and its `listApps` / `getApp`
 * methods delegate to per-test functions installed via {@link setListApps} /
 * {@link setGetApp}. The actions/provider/formatters under test all run for real.
 */

import { mock } from "bun:test";
import type {
  ActivateAppFrontendResponse,
  AdCampaignAttributionResponse,
  AppBackupSnapshot,
  AppDeployStatusResponse,
  AppDto,
  AppEarningsResponse,
  AppMonetizationResponse,
  AppResponse,
  BuyAppDomainInput,
  BuyAppDomainResponse,
  CampaignDaypartingResponse,
  CheckAppDomainInput,
  CheckAppDomainResponse,
  CreateAdSlotInput,
  CreateAdSlotResponse,
  CreateAppInput,
  CreateAppResponse,
  CreateBookingInput,
  CreateBookingResponse,
  CreateInfluencerProfileInput,
  CreateInfluencerProfileResponse,
  DeleteAppResponse,
  DeployAppFrontendInput,
  DeployAppFrontendResponse,
  DeployAppInput,
  DeployAppResponse,
  DuplicateAdCampaignInput,
  DuplicateAdCampaignResponse,
  ExportAppBackupResponse,
  ListAdSlotsResponse,
  ListAppDomainsResponse,
  ListAppFrontendDeploymentsResponse,
  ListAppsResponse,
  ListInfluencersResponse,
  RegenerateAppApiKeyResponse,
  UpdateAppInput,
  UpdateAppMonetizationInput,
  UpdateCampaignDaypartingInput,
  WithdrawAppEarningsRequest,
  WithdrawAppEarningsResponse,
} from "@elizaos/cloud-sdk";
import type { IAgentRuntime, Memory, Task, UUID } from "@elizaos/core";

type ListAppsFn = () => Promise<ListAppsResponse>;
type GetAppFn = (id: string) => Promise<AppResponse>;
type CreateAppFn = (input: CreateAppInput) => Promise<CreateAppResponse>;
type CreateAdSlotFn = (
  input: CreateAdSlotInput,
) => Promise<CreateAdSlotResponse>;
type ListAdSlotsFn = () => Promise<ListAdSlotsResponse>;
type UpdateAdCampaignDaypartingFn = (
  campaignId: string,
  input: UpdateCampaignDaypartingInput,
) => Promise<CampaignDaypartingResponse>;
type DuplicateAdCampaignFn = (
  campaignId: string,
  input?: DuplicateAdCampaignInput,
) => Promise<DuplicateAdCampaignResponse>;
type GetAdCampaignAttributionFn = (
  campaignId: string,
) => Promise<AdCampaignAttributionResponse>;
type ListFrontendDeploymentsFn = (
  appId: string,
) => Promise<ListAppFrontendDeploymentsResponse>;
type ActivateFrontendFn = (
  appId: string,
  deploymentId: string,
) => Promise<ActivateAppFrontendResponse>;
type DeployAppFrontendFn = (
  id: string,
  input: DeployAppFrontendInput,
) => Promise<DeployAppFrontendResponse>;
type CreateBookingFn = (
  input: CreateBookingInput,
) => Promise<CreateBookingResponse>;
type CreateInfluencerProfileFn = (
  input: CreateInfluencerProfileInput,
) => Promise<CreateInfluencerProfileResponse>;
type ListInfluencersFn = (niche?: string) => Promise<ListInfluencersResponse>;
type ExportAppBackupFn = (appId: string) => Promise<ExportAppBackupResponse>;
type DeployAppFn = (
  id: string,
  input?: DeployAppInput,
) => Promise<DeployAppResponse>;
type GetAppDeployStatusFn = (id: string) => Promise<AppDeployStatusResponse>;
type DeleteAppFn = (id: string) => Promise<DeleteAppResponse>;
type UpdateAppFn = (id: string, patch: UpdateAppInput) => Promise<AppResponse>;
type UpdateMonetizationFn = (
  id: string,
  settings: UpdateAppMonetizationInput,
) => Promise<AppMonetizationResponse>;
type GetAppEarningsFn = (
  id: string,
  options?: { days?: number },
) => Promise<AppEarningsResponse>;
type WithdrawAppEarningsFn = (
  id: string,
  request: WithdrawAppEarningsRequest,
) => Promise<WithdrawAppEarningsResponse>;
type RegenerateAppApiKeyFn = (
  id: string,
) => Promise<RegenerateAppApiKeyResponse>;
type CheckAppDomainFn = (
  id: string,
  input: CheckAppDomainInput,
) => Promise<CheckAppDomainResponse>;
type BuyAppDomainFn = (
  id: string,
  input: BuyAppDomainInput,
) => Promise<BuyAppDomainResponse>;
type ListAppDomainsFn = (id: string) => Promise<ListAppDomainsResponse>;

type CloudAppsTestRuntime = Pick<
  IAgentRuntime,
  "agentId" | "getSetting" | "getTasks" | "createTask" | "deleteTask"
>;

interface SdkState {
  listApps: ListAppsFn;
  getApp: GetAppFn;
  createApp: CreateAppFn;
  deployApp: DeployAppFn;
  createAdSlot: CreateAdSlotFn;
  listAdSlots: ListAdSlotsFn;
  updateAdCampaignDayparting: UpdateAdCampaignDaypartingFn;
  duplicateAdCampaign: DuplicateAdCampaignFn;
  getAdCampaignAttribution: GetAdCampaignAttributionFn;
  deployAppFrontend: DeployAppFrontendFn;
  listAppFrontendDeployments: ListFrontendDeploymentsFn;
  activateAppFrontend: ActivateFrontendFn;
  createInfluencerProfile: CreateInfluencerProfileFn;
  createBooking: CreateBookingFn;
  listInfluencers: ListInfluencersFn;
  exportAppBackup: ExportAppBackupFn;
  getAppDeployStatus: GetAppDeployStatusFn;
  deleteApp: DeleteAppFn;
  updateApp: UpdateAppFn;
  updateMonetization: UpdateMonetizationFn;
  getAppEarnings: GetAppEarningsFn;
  withdrawAppEarnings: WithdrawAppEarningsFn;
  regenerateAppApiKey: RegenerateAppApiKeyFn;
  checkAppDomain: CheckAppDomainFn;
  buyAppDomain: BuyAppDomainFn;
  listAppDomains: ListAppDomainsFn;
}

function defaultState(): SdkState {
  return {
    listApps: () => Promise.resolve({ success: true, apps: [] }),
    getApp: () =>
      Promise.resolve({ success: true, app: undefined as unknown as AppDto }),
    createApp: () =>
      Promise.resolve({
        success: true,
        app: undefined as unknown as AppDto,
        apiKey: "eliza_app_secret",
      }),
    deployApp: () =>
      Promise.resolve({
        success: true,
        deploymentId: "dep_1",
        status: "BUILDING",
        startedAt: "2026-06-29T00:00:00.000Z",
      }),
    createAdSlot: () =>
      Promise.resolve({
        success: true,
        slot: {
          id: "slot_1",
          app_id: "app_1",
          name: "Slot",
          format: "banner",
          status: "active",
          floor_cpm: "10.0000",
          total_impressions: 0,
          total_clicks: 0,
          total_revenue: "0.000000",
        },
        adTagToken: "v1.9999999999.deadbeef",
      }),
    listAdSlots: () => Promise.resolve({ success: true, slots: [] }),
    updateAdCampaignDayparting: (_campaignId, input) =>
      Promise.resolve({
        success: true,
        campaignId: "campaign_1",
        status: "draft",
        dayparting: input.dayparting,
        updatedAt: "2026-07-02T00:00:00.000Z",
      }),
    duplicateAdCampaign: (_campaignId, input) =>
      Promise.resolve({
        success: true,
        campaign: {
          id: "campaign_copy",
          name: input?.name ?? "Campaign Copy",
          platform: "meta",
          objective: "traffic",
          status: "draft",
          budgetType: "daily",
          budgetAmount: "100.00",
          budgetCurrency: "USD",
          creditsAllocated: "0.00",
          externalCampaignId: null,
          dayparting: null,
          sourceCampaignId: "campaign_1",
          createdAt: "2026-07-02T00:00:00.000Z",
        },
        creativesCopied: 1,
      }),
    getAdCampaignAttribution: (campaignId) =>
      Promise.resolve({
        success: true,
        campaignId,
        appId: "app_1",
        token: "payloadpart.signaturepart123456789",
        pixelEndpoint:
          "https://cloud.test/api/v1/advertising/conversions/track?token=payloadpart.signaturepart123456789",
        webhookEndpoint:
          "https://cloud.test/api/v1/advertising/conversions/track",
        install: {
          pixelHtml:
            '<img src="https://cloud.test/api/v1/advertising/conversions/track?token=payloadpart.signaturepart123456789&eventType=conversion&dedupeKey=ORDER_OR_EVENT_ID" width="1" height="1" style="display:none" alt="" />',
          webhook: {
            url: "https://cloud.test/api/v1/advertising/conversions/track",
            method: "POST",
            body: {
              token: "payloadpart.signaturepart123456789",
              eventType: "purchase",
              dedupeKey: "ORDER_OR_EVENT_ID",
            },
          },
        },
      }),
    deployAppFrontend: () =>
      Promise.resolve({
        success: true,
        deployment: {
          id: "fe_dep_1",
          app_id: "app_1",
          version: 1,
          status: "active",
          r2_prefix: "app-frontends/o/app_1/fe_dep_1/",
          content_hash: "a".repeat(64),
          file_count: 1,
          total_bytes: 100,
          error: null,
          created_at: "2026-06-29T00:00:00.000Z",
          activated_at: "2026-06-29T00:00:00.000Z",
        },
      }),
    listAppFrontendDeployments: () =>
      Promise.resolve({
        success: true,
        active_deployment_id: null,
        deployments: [],
      }),
    activateAppFrontend: (_a, id) =>
      Promise.resolve({
        success: true,
        deployment: {
          id,
          app_id: "app_1",
          version: 1,
          status: "active",
          r2_prefix: "p",
          content_hash: null,
          file_count: 0,
          total_bytes: 0,
          error: null,
          created_at: "2020-01-01",
          activated_at: "2020-01-01",
        },
      }),
    createInfluencerProfile: () =>
      Promise.resolve({
        success: true,
        profile: {
          id: "inf_1",
          display_name: "Creator",
          niche: null,
          bio: null,
          platforms: [],
          status: "active",
        },
      }),
    listInfluencers: () => Promise.resolve({ success: true, profiles: [] }),
    createBooking: () =>
      Promise.resolve({
        success: true,
        booking: {
          id: "bk_1",
          advertiser_org_id: "org",
          influencer_profile_id: "inf_1",
          amount: "100.00",
          status: "offered",
          brief: "b",
        },
      }),
    exportAppBackup: () =>
      Promise.resolve({
        success: true,
        backup: {
          version: 1,
          exportedAt: "2020-01-01T00:00:00Z",
          app: {
            name: "App",
            description: null,
            app_url: "https://a",
            allowed_origins: [],
            logo_url: null,
            website_url: null,
            contact_email: null,
            linked_character_ids: [],
          },
          monetization: {
            enabled: false,
            inference_markup_percentage: 0,
            purchase_share_percentage: 0,
          },
        } as AppBackupSnapshot,
      }),
    getAppDeployStatus: () =>
      Promise.resolve({
        success: true,
        deploymentId: "dep_1",
        status: "READY",
        vercelUrl: null,
        error: null,
        startedAt: null,
      }),
    deleteApp: () => Promise.resolve({ success: true, message: "deleted" }),
    updateApp: () =>
      Promise.resolve({ success: true, app: undefined as unknown as AppDto }),
    updateMonetization: () =>
      Promise.resolve({ success: true, monetization: null }),
    getAppEarnings: () => Promise.resolve({ success: true }),
    withdrawAppEarnings: () =>
      Promise.resolve({ success: true, message: "withdrawn", newBalance: 0 }),
    regenerateAppApiKey: () =>
      Promise.resolve({ success: true, apiKey: "eliza_app_rotated" }),
    checkAppDomain: (_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        available: true,
        currency: "USD",
        years: 1,
        price: {
          wholesaleUsdCents: 1029,
          marginUsdCents: 370,
          totalUsdCents: 1399,
          marginBps: 3600,
        },
        renewal: { totalUsdCents: 1399 },
      }),
    buyAppDomain: (_id, input) =>
      Promise.resolve({
        success: true,
        domain: input.domain,
        appDomainId: "ad_1",
        zoneId: "zone_1",
        status: "pending",
        verified: false,
        expiresAt: "2027-07-01T00:00:00.000Z",
        pendingZoneProvisioning: false,
        debited: { totalUsdCents: 1399, currency: "USD" },
      }),
    listAppDomains: () => Promise.resolve({ success: true, domains: [] }),
  };
}

const state: SdkState = defaultState();
const TEST_AGENT_ID = "agent-0000-0000-0000-000000000000" as UUID;

export function setListApps(fn: ListAppsFn): void {
  state.listApps = fn;
}
export function setGetApp(fn: GetAppFn): void {
  state.getApp = fn;
}
export function setCreateApp(fn: CreateAppFn): void {
  state.createApp = fn;
}
export function setDeployApp(fn: DeployAppFn): void {
  state.deployApp = fn;
}
export function setCreateAdSlot(fn: CreateAdSlotFn): void {
  state.createAdSlot = fn;
}
export function setListAdSlots(fn: ListAdSlotsFn): void {
  state.listAdSlots = fn;
}
export function setUpdateAdCampaignDayparting(
  fn: UpdateAdCampaignDaypartingFn,
): void {
  state.updateAdCampaignDayparting = fn;
}
export function setDuplicateAdCampaign(fn: DuplicateAdCampaignFn): void {
  state.duplicateAdCampaign = fn;
}
export function setGetAdCampaignAttribution(
  fn: GetAdCampaignAttributionFn,
): void {
  state.getAdCampaignAttribution = fn;
}
export function setDeployAppFrontend(fn: DeployAppFrontendFn): void {
  state.deployAppFrontend = fn;
}
export function setListAppFrontendDeployments(
  fn: ListFrontendDeploymentsFn,
): void {
  state.listAppFrontendDeployments = fn;
}
export function setActivateAppFrontend(fn: ActivateFrontendFn): void {
  state.activateAppFrontend = fn;
}
export function setCreateInfluencerProfile(
  fn: CreateInfluencerProfileFn,
): void {
  state.createInfluencerProfile = fn;
}
export function setListInfluencers(fn: ListInfluencersFn): void {
  state.listInfluencers = fn;
}
export function setCreateBooking(fn: CreateBookingFn): void {
  state.createBooking = fn;
}
export function setExportAppBackup(fn: ExportAppBackupFn): void {
  state.exportAppBackup = fn;
}
export function setGetAppDeployStatus(fn: GetAppDeployStatusFn): void {
  state.getAppDeployStatus = fn;
}
export function setDeleteApp(fn: DeleteAppFn): void {
  state.deleteApp = fn;
}
export function setUpdateApp(fn: UpdateAppFn): void {
  state.updateApp = fn;
}
export function setUpdateMonetization(fn: UpdateMonetizationFn): void {
  state.updateMonetization = fn;
}
export function setGetAppEarnings(fn: GetAppEarningsFn): void {
  state.getAppEarnings = fn;
}
export function setWithdrawAppEarnings(fn: WithdrawAppEarningsFn): void {
  state.withdrawAppEarnings = fn;
}
export function setRegenerateAppApiKey(fn: RegenerateAppApiKeyFn): void {
  state.regenerateAppApiKey = fn;
}
export function setCheckAppDomain(fn: CheckAppDomainFn): void {
  state.checkAppDomain = fn;
}
export function setBuyAppDomain(fn: BuyAppDomainFn): void {
  state.buyAppDomain = fn;
}
export function setListAppDomains(fn: ListAppDomainsFn): void {
  state.listAppDomains = fn;
}

/** Restore default (empty / no-op) behavior between tests. */
export function resetSdk(): void {
  Object.assign(state, defaultState());
}

/** Stand-in for `ElizaCloudClient` — the methods the plugin calls. */
export class FakeElizaCloudClient {
  listApps(): Promise<ListAppsResponse> {
    return state.listApps();
  }
  getApp(id: string): Promise<AppResponse> {
    return state.getApp(id);
  }
  createApp(input: CreateAppInput): Promise<CreateAppResponse> {
    return state.createApp(input);
  }
  deployApp(id: string, input?: DeployAppInput): Promise<DeployAppResponse> {
    return state.deployApp(id, input);
  }
  createAdSlot(input: CreateAdSlotInput): Promise<CreateAdSlotResponse> {
    return state.createAdSlot(input);
  }
  listAdSlots(): Promise<ListAdSlotsResponse> {
    return state.listAdSlots();
  }
  updateAdCampaignDayparting(
    campaignId: string,
    input: UpdateCampaignDaypartingInput,
  ): Promise<CampaignDaypartingResponse> {
    return state.updateAdCampaignDayparting(campaignId, input);
  }
  duplicateAdCampaign(
    campaignId: string,
    input?: DuplicateAdCampaignInput,
  ): Promise<DuplicateAdCampaignResponse> {
    return state.duplicateAdCampaign(campaignId, input);
  }
  getAdCampaignAttribution(
    campaignId: string,
  ): Promise<AdCampaignAttributionResponse> {
    return state.getAdCampaignAttribution(campaignId);
  }
  deployAppFrontend(
    id: string,
    input: DeployAppFrontendInput,
  ): Promise<DeployAppFrontendResponse> {
    return state.deployAppFrontend(id, input);
  }
  listAppFrontendDeployments(
    appId: string,
  ): Promise<ListAppFrontendDeploymentsResponse> {
    return state.listAppFrontendDeployments(appId);
  }
  activateAppFrontend(
    appId: string,
    deploymentId: string,
  ): Promise<ActivateAppFrontendResponse> {
    return state.activateAppFrontend(appId, deploymentId);
  }
  createInfluencerProfile(
    input: CreateInfluencerProfileInput,
  ): Promise<CreateInfluencerProfileResponse> {
    return state.createInfluencerProfile(input);
  }
  listInfluencers(niche?: string): Promise<ListInfluencersResponse> {
    return state.listInfluencers(niche);
  }
  createBooking(input: CreateBookingInput): Promise<CreateBookingResponse> {
    return state.createBooking(input);
  }
  exportAppBackup(appId: string): Promise<ExportAppBackupResponse> {
    return state.exportAppBackup(appId);
  }
  getAppDeployStatus(id: string): Promise<AppDeployStatusResponse> {
    return state.getAppDeployStatus(id);
  }
  deleteApp(id: string): Promise<DeleteAppResponse> {
    return state.deleteApp(id);
  }
  updateApp(id: string, patch: UpdateAppInput): Promise<AppResponse> {
    return state.updateApp(id, patch);
  }
  updateMonetization(
    id: string,
    settings: UpdateAppMonetizationInput,
  ): Promise<AppMonetizationResponse> {
    return state.updateMonetization(id, settings);
  }
  getAppEarnings(
    id: string,
    options?: { days?: number },
  ): Promise<AppEarningsResponse> {
    return state.getAppEarnings(id, options);
  }
  withdrawAppEarnings(
    id: string,
    request: WithdrawAppEarningsRequest,
  ): Promise<WithdrawAppEarningsResponse> {
    return state.withdrawAppEarnings(id, request);
  }
  regenerateAppApiKey(id: string): Promise<RegenerateAppApiKeyResponse> {
    return state.regenerateAppApiKey(id);
  }
  checkAppDomain(
    id: string,
    input: CheckAppDomainInput,
  ): Promise<CheckAppDomainResponse> {
    return state.checkAppDomain(id, input);
  }
  buyAppDomain(
    id: string,
    input: BuyAppDomainInput,
  ): Promise<BuyAppDomainResponse> {
    return state.buyAppDomain(id, input);
  }
  listAppDomains(id: string): Promise<ListAppDomainsResponse> {
    return state.listAppDomains(id);
  }
}

/** Build a minimal runtime exposing just `getSetting`. */
export function makeRuntime(
  settings: Record<string, string | undefined> = {},
): IAgentRuntime {
  const tasks: Task[] = [];
  let taskCounter = 0;
  const runtime: CloudAppsTestRuntime = {
    agentId: TEST_AGENT_ID,
    getSetting: (key: string) => settings[key] ?? null,
    getTasks: (params) =>
      Promise.resolve(
        tasks.filter((task) => {
          const agentMatches = params.agentIds.includes(task.agentId);
          const tagMatches =
            !params.tags ||
            params.tags.every((tag) => task.tags?.includes(tag));
          return agentMatches && tagMatches;
        }),
      ),
    createTask: (task: Task) => {
      const id =
        `task-0000-0000-0000-${String(++taskCounter).padStart(12, "0")}` as UUID;
      tasks.push({
        ...task,
        id,
        agentId: task.agentId ?? TEST_AGENT_ID,
      });
      return Promise.resolve(id);
    },
    deleteTask: (id: UUID) => {
      const idx = tasks.findIndex((task) => task.id === id);
      if (idx >= 0) tasks.splice(idx, 1);
      return Promise.resolve();
    },
  };
  return runtime as IAgentRuntime;
}

/** A runtime with a valid Cloud API key configured. */
export function keyedRuntime(): IAgentRuntime {
  return makeRuntime({ ELIZAOS_CLOUD_API_KEY: "eliza_test_key" });
}

/** A runtime with no Cloud API key. */
export function unkeyedRuntime(): IAgentRuntime {
  return makeRuntime({});
}

/**
 * A keyed runtime backed by a real in-memory `facts` store, so the facts-cache
 * code under test exercises its actual create/get/update logic (only the store
 * boundary is faked — the dedup + write path runs for real).
 */
export interface MemoryRuntime extends IAgentRuntime {
  __facts: Memory[];
}

export function memoryRuntime(
  settings: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_API_KEY: "eliza_test_key",
  },
): MemoryRuntime {
  const facts: Memory[] = [];
  let counter = 0;
  const tasks: Task[] = [];
  let taskCounter = 0;
  const runtime = {
    agentId: TEST_AGENT_ID,
    __facts: facts,
    getSetting: (key: string) => settings[key] as unknown,
    // Same in-memory task store as makeRuntime, so actions that combine the
    // two-phase confirm machine WITH facts writes run for real here too.
    getTasks: (params: { agentIds: string[]; tags?: string[] }) =>
      Promise.resolve(
        tasks.filter((task) => {
          const agentMatches = params.agentIds.includes(task.agentId);
          const tagMatches =
            !params.tags ||
            params.tags.every((tag) => task.tags?.includes(tag));
          return agentMatches && tagMatches;
        }),
      ),
    createTask: (task: Task) => {
      const id =
        `task-0000-0000-0000-${String(++taskCounter).padStart(12, "0")}` as UUID;
      tasks.push({ ...task, id, agentId: task.agentId ?? TEST_AGENT_ID });
      return Promise.resolve(id);
    },
    deleteTask: (id: UUID) => {
      const idx = tasks.findIndex((task) => task.id === id);
      if (idx >= 0) tasks.splice(idx, 1);
      return Promise.resolve();
    },
    getMemories: (params: { tableName: string }) =>
      Promise.resolve(params.tableName === "facts" ? [...facts] : []),
    createMemory: (memory: Memory, tableName: string) => {
      const id = `mem-${++counter}`;
      if (tableName === "facts") facts.push({ ...memory, id } as Memory);
      return Promise.resolve(id);
    },
    updateMemory: (patch: Partial<Memory> & { id: string }) => {
      const idx = facts.findIndex(
        (m) => (m as { id?: string }).id === patch.id,
      );
      if (idx >= 0) facts[idx] = { ...facts[idx], ...patch } as Memory;
      return Promise.resolve(idx >= 0);
    },
    deleteMemory: (id: string) => {
      const idx = facts.findIndex((m) => (m as { id?: string }).id === id);
      if (idx >= 0) facts.splice(idx, 1);
      return Promise.resolve();
    },
  } as unknown as MemoryRuntime;
  return runtime;
}

/** Build a message Memory with entity/room ids (for memory-writing actions). */
export function makeRoomMessage(text: string): Memory {
  return {
    id: "msg-0000-0000-0000-000000000000",
    entityId: "entity-0000-0000-0000-000000000000",
    roomId: "room-0000-0000-0000-000000000000",
    content: { text },
  } as unknown as Memory;
}

/** Build a message Memory with the given text. */
export function makeMessage(text: string): Memory {
  return {
    content: { text },
  } as unknown as Memory;
}

/** A callback that records the content it was called with. */
export function captureCallback(): {
  fn: (content: { text?: string; actions?: string[] }) => Promise<Memory[]>;
  calls: Array<{ text?: string; actions?: string[] }>;
} {
  const calls: Array<{ text?: string; actions?: string[] }> = [];
  const fn = mock((content: { text?: string; actions?: string[] }) => {
    calls.push(content);
    return Promise.resolve([] as Memory[]);
  });
  return { fn, calls };
}

/** Minimal AppDto factory — fills only the fields the read-core reads. */
export function makeApp(overrides: Partial<AppDto> = {}): AppDto {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Test App",
    description: null,
    slug: "test-app",
    organization_id: "org-1",
    created_by_user_id: "user-1",
    app_url: "https://test-app.example.com",
    allowed_origins: [],
    api_key_id: null,
    affiliate_code: null,
    referral_bonus_credits: null,
    total_requests: 0,
    total_users: 0,
    total_credits_used: null,
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "draft",
    production_url: null,
    last_deployed_at: null,
    github_repo: null,
    linked_character_ids: null,
    monetization_enabled: false,
    inference_markup_percentage: null,
    purchase_share_percentage: null,
    platform_offset_amount: null,
    custom_pricing_enabled: null,
    total_creator_earnings: null,
    total_platform_revenue: null,
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    is_approved: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    last_used_at: null,
    ...overrides,
  };
}
