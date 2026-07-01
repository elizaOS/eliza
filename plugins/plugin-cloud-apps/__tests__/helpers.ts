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
  AppDeployStatusResponse,
  AppDto,
  AppEarningsResponse,
  AppMonetizationResponse,
  AppResponse,
  CreateAppInput,
  CreateAppResponse,
  DeleteAppResponse,
  DeployAppInput,
  DeployAppResponse,
  ListAppsResponse,
  RegenerateAppApiKeyResponse,
  UpdateAppInput,
  UpdateAppMonetizationInput,
  WithdrawAppEarningsRequest,
  WithdrawAppEarningsResponse,
  type CreateAdSlotInput,
  type CreateAdSlotResponse,
  type ListAdSlotsResponse,
} from "@elizaos/cloud-sdk";
import type { IAgentRuntime, Memory, Task, UUID } from "@elizaos/core";

type ListAppsFn = () => Promise<ListAppsResponse>;
type GetAppFn = (id: string) => Promise<AppResponse>;
type CreateAppFn = (input: CreateAppInput) => Promise<CreateAppResponse>;
type CreateAdSlotFn = (input: CreateAdSlotInput) => Promise<CreateAdSlotResponse>;
type ListAdSlotsFn = () => Promise<ListAdSlotsResponse>;
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
  getAppDeployStatus: GetAppDeployStatusFn;
  deleteApp: DeleteAppFn;
  updateApp: UpdateAppFn;
  updateMonetization: UpdateMonetizationFn;
  getAppEarnings: GetAppEarningsFn;
  withdrawAppEarnings: WithdrawAppEarningsFn;
  regenerateAppApiKey: RegenerateAppApiKeyFn;
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
      Promise.resolve({ success: true, slot: { id: "slot_1", app_id: "app_1", name: "Slot", format: "banner", status: "active", floor_cpm: "1.0000", total_impressions: 0, total_clicks: 0, total_revenue: "0.000000" } }),
    listAdSlots: () => Promise.resolve({ success: true, slots: [] }),
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
  const runtime = {
    agentId: "agent-0000-0000-0000-000000000000",
    __facts: facts,
    getSetting: (key: string) => settings[key] as unknown,
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
