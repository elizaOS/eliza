import type { IAgentRuntime, Task } from "@elizaos/core";
import { loadElizaConfig, saveElizaConfig } from "../config/config.js";
import {
  ensureLifeOpsSchedulerTask,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  resolveLifeOpsTaskIntervalMs,
} from "./runtime.js";

const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";
export const OWNER_NAME_MAX_LENGTH = 60;
const OWNER_PROFILE_VALUE_MAX_LENGTH = 120;

export const LIFEOPS_OWNER_PROFILE_FIELDS = [
  "name",
  "relationshipStatus",
  "partnerName",
  "orientation",
  "gender",
  "age",
  "location",
] as const;

export type LifeOpsOwnerProfileField =
  (typeof LIFEOPS_OWNER_PROFILE_FIELDS)[number];

export type LifeOpsOwnerProfilePatch = Partial<
  Record<LifeOpsOwnerProfileField, string>
>;

export type LifeOpsOwnerProfile = Record<LifeOpsOwnerProfileField, string> & {
  updatedAt: string | null;
};

const DEFAULT_OWNER_PROFILE: LifeOpsOwnerProfile = {
  name: "admin",
  relationshipStatus: "n/a",
  partnerName: "n/a",
  orientation: "n/a",
  gender: "n/a",
  age: "n/a",
  location: "n/a",
  updatedAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeProfileValue(
  value: unknown,
  maxLength = OWNER_PROFILE_VALUE_MAX_LENGTH,
): string | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function isLifeOpsSchedulerTask(task: Task): boolean {
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  return (
    task.name === LIFEOPS_TASK_NAME &&
    isRecord(metadata?.lifeopsScheduler) &&
    metadata.lifeopsScheduler.kind === "runtime_runner"
  );
}

function buildFallbackSchedulerMetadata(
  agentId: string,
): Record<string, unknown> {
  const intervalMs = resolveLifeOpsTaskIntervalMs(agentId as never);
  return {
    updateInterval: intervalMs,
    baseInterval: intervalMs,
    blocking: true,
    lifeopsScheduler: {
      kind: "runtime_runner",
      version: 1,
    },
  };
}

function readConfiguredOwnerNameFromConfig(): string | null {
  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : null;
    return normalizeProfileValue(ui?.ownerName, OWNER_NAME_MAX_LENGTH);
  } catch {
    return null;
  }
}

function writeConfiguredOwnerNameToConfig(name: string): boolean {
  const normalized = normalizeProfileValue(name, OWNER_NAME_MAX_LENGTH);
  if (!normalized) {
    return false;
  }

  try {
    const config = loadElizaConfig() as Record<string, unknown>;
    const nextUi = isRecord(config.ui) ? config.ui : {};
    saveElizaConfig({
      ...config,
      ui: {
        ...nextUi,
        ownerName: normalized,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function readLifeOpsSchedulerTask(
  runtime: IAgentRuntime,
): Promise<Task | null> {
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...LIFEOPS_TASK_TAGS],
  });
  return tasks.find(isLifeOpsSchedulerTask) ?? null;
}

export function normalizeLifeOpsOwnerProfilePatch(
  patch: Record<string, unknown> | LifeOpsOwnerProfilePatch | null | undefined,
): LifeOpsOwnerProfilePatch {
  if (!patch) {
    return {};
  }

  const normalized: LifeOpsOwnerProfilePatch = {};
  for (const field of LIFEOPS_OWNER_PROFILE_FIELDS) {
    const value = normalizeProfileValue(
      patch[field],
      field === "name" ? OWNER_NAME_MAX_LENGTH : OWNER_PROFILE_VALUE_MAX_LENGTH,
    );
    if (value) {
      normalized[field] = value;
    }
  }
  return normalized;
}

export async function fetchConfiguredOwnerName(): Promise<string | null> {
  const fromConfig = readConfiguredOwnerNameFromConfig();
  if (fromConfig) {
    return fromConfig;
  }

  try {
    const response = await fetch(`http://localhost:${API_PORT}/api/config`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return null;
    }
    const config = (await response.json()) as Record<string, unknown>;
    const ui = isRecord(config.ui) ? config.ui : null;
    return normalizeProfileValue(ui?.ownerName, OWNER_NAME_MAX_LENGTH);
  } catch {
    return null;
  }
}

export async function persistConfiguredOwnerName(
  name: string,
): Promise<boolean> {
  const normalized = normalizeProfileValue(name, OWNER_NAME_MAX_LENGTH);
  if (!normalized) {
    return false;
  }

  const savedToConfig = writeConfiguredOwnerNameToConfig(normalized);
  try {
    const response = await fetch(`http://localhost:${API_PORT}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui: { ownerName: normalized } }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok || savedToConfig;
  } catch {
    return savedToConfig;
  }
}

export function resolveLifeOpsOwnerProfile(
  metadata: Record<string, unknown> | null | undefined,
  configuredName?: string | null,
): LifeOpsOwnerProfile {
  const ownerProfile = isRecord(metadata?.ownerProfile)
    ? metadata.ownerProfile
    : null;
  const normalized = normalizeLifeOpsOwnerProfilePatch(ownerProfile);
  const updatedAt =
    ownerProfile && typeof ownerProfile.updatedAt === "string"
      ? normalizeProfileValue(ownerProfile.updatedAt, 64)
      : null;

  return {
    ...DEFAULT_OWNER_PROFILE,
    ...(configuredName ? { name: configuredName } : {}),
    ...normalized,
    updatedAt,
  };
}

export async function readLifeOpsOwnerProfile(
  runtime: IAgentRuntime,
): Promise<LifeOpsOwnerProfile> {
  const [configuredName, task] = await Promise.all([
    fetchConfiguredOwnerName(),
    readLifeOpsSchedulerTask(runtime).catch(() => null),
  ]);
  const metadata = isRecord(task?.metadata) ? task.metadata : null;
  return resolveLifeOpsOwnerProfile(metadata, configuredName);
}

export async function updateLifeOpsOwnerProfile(
  runtime: IAgentRuntime,
  patch: LifeOpsOwnerProfilePatch | Record<string, unknown>,
): Promise<LifeOpsOwnerProfile | null> {
  const normalizedPatch = normalizeLifeOpsOwnerProfilePatch(patch);
  if (Object.keys(normalizedPatch).length === 0) {
    return null;
  }

  const taskId = await ensureLifeOpsSchedulerTask(runtime);
  const [configuredName, task] = await Promise.all([
    fetchConfiguredOwnerName(),
    readLifeOpsSchedulerTask(runtime).catch(() => null),
  ]);

  const metadata =
    isRecord(task?.metadata) && task.id === taskId
      ? task.metadata
      : buildFallbackSchedulerMetadata(runtime.agentId);
  const nextProfile: LifeOpsOwnerProfile = {
    ...resolveLifeOpsOwnerProfile(metadata, configuredName),
    ...normalizedPatch,
    updatedAt: new Date().toISOString(),
  };

  await runtime.updateTask(taskId, {
    metadata: {
      ...(metadata ?? {}),
      ownerProfile: nextProfile,
    },
  });

  return nextProfile;
}
