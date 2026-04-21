import { execFile } from "node:child_process";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { domainToASCII } from "node:url";
import { promisify } from "node:util";
import type { HandlerOptions } from "@elizaos/core";
import type { PermissionState, PermissionStatus } from "./permissions.ts";

const BLOCK_START_MARKER = "# >>> eliza-selfcontrol >>>";
const BLOCK_END_MARKER = "# <<< eliza-selfcontrol <<<";
const BLOCK_METADATA_PREFIX = "# eliza-selfcontrol ";
const DEFAULT_STATUS_CACHE_TTL_MS = 5_000;
const DEFAULT_DURATION_MINUTES = 60;

// ---------------------------------------------------------------------------
// Native backend adapter
// ---------------------------------------------------------------------------
// On iOS and Android the hosts-file engine is not available. A native backend
// can be registered at startup so the action/provider layer dispatches to the
// Capacitor native plugin (Safari content blocker on iOS, VPN DNS on Android)
// instead of falling through to "not-applicable".
//
// The mobile app's webview startup code calls `registerNativeWebsiteBlockerBackend`
// with an adapter that wraps the Capacitor plugin.
// ---------------------------------------------------------------------------

export interface NativeWebsiteBlockerBackend {
  getStatus(): Promise<SelfControlStatus>;
  startBlock(request: SelfControlBlockRequest): Promise<
    | { success: true; endsAt: string | null }
    | { success: false; error: string; status?: SelfControlStatus }
  >;
  stopBlock(): Promise<
    | { success: true; removed: boolean; status: SelfControlStatus }
    | { success: false; error: string; status?: SelfControlStatus }
  >;
  getPermissionState(): Promise<SelfControlPermissionState>;
  requestPermission(): Promise<SelfControlPermissionState>;
}

let nativeBackend: NativeWebsiteBlockerBackend | null = null;

export function registerNativeWebsiteBlockerBackend(
  backend: NativeWebsiteBlockerBackend,
): void {
  nativeBackend = backend;
}

export function getNativeWebsiteBlockerBackend(): NativeWebsiteBlockerBackend | null {
  return nativeBackend;
}
const MAX_BLOCK_MINUTES = 7 * 24 * 60;
const PRIVILEGED_WRITE_TMP_PREFIX = "eliza-selfcontrol-write-";
const WINDOWS_WORKER_SCRIPT_NAME = "write-hosts.ps1";

const execFileAsync = promisify(execFile);

export type SelfControlElevationMethod =
  | "osascript"
  | "pkexec"
  | "powershell-runas";

export interface SelfControlPluginConfig {
  hostsFilePath?: string;
  statusCacheTtlMs?: number;
}

export interface SelfControlStatus {
  available: boolean;
  active: boolean;
  hostsFilePath: string | null;
  startedAt: string | null;
  endsAt: string | null;
  websites: string[];
  managedBy: string | null;
  metadata: Record<string, unknown> | null;
  scheduledByAgentId: string | null;
  canUnblockEarly: boolean;
  requiresElevation: boolean;
  engine: "hosts-file";
  platform: NodeJS.Platform;
  supportsElevationPrompt: boolean;
  elevationPromptMethod: SelfControlElevationMethod | null;
  reason?: string;
}

export interface SelfControlPermissionState extends PermissionState {
  id: "website-blocking";
  hostsFilePath?: string | null;
  supportsElevationPrompt?: boolean;
  elevationPromptMethod?: SelfControlElevationMethod | null;
  promptAttempted?: boolean;
  promptSucceeded?: boolean;
}

export interface SelfControlBlockRequest {
  websites: string[];
  durationMinutes: number | null;
  metadata?: Record<string, unknown> | null;
  scheduledByAgentId?: string | null;
}

export interface SelfControlBlockMetadata {
  version: 1;
  startedAt: string;
  endsAt: string | null;
  websites: string[];
  managedBy: string | null;
  metadata: Record<string, unknown> | null;
  scheduledByAgentId?: string | null;
}

type StatusCacheEntry = {
  expiresAt: number;
  promise: Promise<SelfControlStatus>;
};

type PrivilegedHostsWriteInvocation = {
  command: string;
  args: string[];
  workerScriptContent?: string;
};

let currentConfig: SelfControlPluginConfig = {};
let statusCache: StatusCacheEntry | undefined;

export function setSelfControlPluginConfig(
  nextConfig: SelfControlPluginConfig | undefined,
): void {
  currentConfig = { ...(nextConfig ?? {}) };
  resetSelfControlStatusCache();
}

export function getSelfControlPluginConfig(): SelfControlPluginConfig {
  return { ...currentConfig };
}

export function resetSelfControlStatusCache(): void {
  statusCache = undefined;
}

export function cancelSelfControlExpiryTimer(): void {
  // Timed website unblocks are scheduled through Eliza tasks now.
}

// ---------------------------------------------------------------------------
// Conversation intent heuristics (hosts-file website blocking)
// ---------------------------------------------------------------------------

export function extractDurationMinutesFromText(text: string): number | null {
  const match = text.match(
    /\bfor\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i,
  );
  if (!match) return null;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const unit = match[2].toLowerCase();
  if (unit.startsWith("day")) {
    return Math.round(amount * 24 * 60);
  }
  if (unit.startsWith("hour") || unit.startsWith("hr")) {
    return Math.round(amount * 60);
  }
  return Math.round(amount);
}

export function hasIndefiniteBlockIntent(text: string): boolean {
  return (
    /\b(indefinitely|until i unblock|until i remove|until i say so|until further notice)\b/i.test(
      text,
    ) || /\bblock\b.*\bforever\b/i.test(text)
  );
}

export function hasWebsiteBlockDeferralIntent(text: string): boolean {
  return (
    /\bdo not block\b/i.test(text) ||
    /\bdon'?t block\b/i.test(text) ||
    /\bnot yet\b/i.test(text) ||
    /\bhold off\b/i.test(text) ||
    /\bwait(?: for me)?(?: to)?\s+(?:confirm|say|tell|be ready)\b/i.test(
      text,
    ) ||
    /\bblock\b.*\blater\b/i.test(text) ||
    /\bself ?control\b.*\blater\b/i.test(text)
  );
}

export function hasWebsiteBlockIntent(text: string): boolean {
  return /\b(block|unblock|self control|selfcontrol|focus)\b/i.test(text);
}

export function extractWebsiteTargetsFromText(text: string): string[] {
  return Array.from(
    text.matchAll(/https?:\/\/[^\s]+|(?<![@/])(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi),
    (match) => match[0],
  );
}

export async function resolveSelfControlHostsFilePath(
  config: SelfControlPluginConfig = currentConfig,
): Promise<string | null> {
  const override =
    config.hostsFilePath?.trim() ||
    process.env.WEBSITE_BLOCKER_HOSTS_FILE_PATH ||
    process.env.SELFCONTROL_HOSTS_FILE_PATH;
  const candidate = override
    ? resolveUserPath(override)
    : defaultHostsFilePath();
  return fs.existsSync(candidate) ? candidate : null;
}

export async function reconcileSelfControlBlockState(
  config: SelfControlPluginConfig = currentConfig,
): Promise<SelfControlStatus> {
  const elevationPromptMethod = resolveSelfControlElevationPromptMethod();
  const supportsElevationPrompt = elevationPromptMethod !== null;

  const hostsFilePath = await resolveSelfControlHostsFilePath(config);
  if (!hostsFilePath) {
    return {
      available: false,
      active: false,
      hostsFilePath: null,
      startedAt: null,
      endsAt: null,
      websites: [],
      managedBy: null,
      metadata: null,
      scheduledByAgentId: null,
      canUnblockEarly: false,
      requiresElevation: false,
      engine: "hosts-file",
      platform: process.platform,
      supportsElevationPrompt,
      elevationPromptMethod,
      reason: "Could not find the system hosts file on this machine.",
    };
  }

  let hostsContent: string;
  try {
    hostsContent = fs.readFileSync(hostsFilePath, "utf8");
  } catch (error) {
    return {
      available: false,
      active: false,
      hostsFilePath,
      startedAt: null,
      endsAt: null,
      websites: [],
      managedBy: null,
      metadata: null,
      scheduledByAgentId: null,
      canUnblockEarly: false,
      requiresElevation: false,
      engine: "hosts-file",
      platform: process.platform,
      supportsElevationPrompt,
      elevationPromptMethod,
      reason: formatFileError(
        error,
        "Eliza could not read the system hosts file.",
      ),
    };
  }

  const block = extractManagedSelfControlBlock(hostsContent);
  const writable = canWriteHostsFile(hostsFilePath);
  const requiresElevation = !writable;
  const permissionWarning = writable
    ? undefined
    : buildElevationReason(supportsElevationPrompt);

  if (!block) {
    return {
      available: true,
      active: false,
      hostsFilePath,
      startedAt: null,
      endsAt: null,
      websites: [],
      managedBy: null,
      metadata: null,
      scheduledByAgentId: null,
      canUnblockEarly: writable,
      requiresElevation,
      engine: "hosts-file",
      platform: process.platform,
      supportsElevationPrompt,
      elevationPromptMethod,
      reason: permissionWarning,
    };
  }

  if (block.endsAt) {
    const endsAtMs = Date.parse(block.endsAt);
    if (Number.isFinite(endsAtMs) && endsAtMs <= Date.now()) {
      if (writable) {
        await clearManagedSelfControlBlock(hostsFilePath, hostsContent, {
          allowElevationPrompt: false,
        });
        return {
          available: true,
          active: false,
          hostsFilePath,
          startedAt: null,
          endsAt: null,
          websites: [],
          managedBy: null,
          metadata: null,
          scheduledByAgentId: null,
          canUnblockEarly: true,
          requiresElevation: false,
          engine: "hosts-file",
          platform: process.platform,
          supportsElevationPrompt,
          elevationPromptMethod,
        };
      }

      return {
        available: true,
        active: true,
        hostsFilePath,
        startedAt: block.startedAt,
        endsAt: block.endsAt,
        websites: block.websites,
        managedBy: block.managedBy,
        metadata: block.metadata,
        scheduledByAgentId: block.scheduledByAgentId,
        canUnblockEarly: false,
        requiresElevation: true,
        engine: "hosts-file",
        platform: process.platform,
        supportsElevationPrompt,
        elevationPromptMethod,
        reason: supportsElevationPrompt
          ? "The website block has expired, but Eliza still needs administrator/root approval to remove it."
          : "The website block has expired, but Eliza cannot remove it without administrator/root access.",
      };
    }
  }

  return {
    available: true,
    active: true,
    hostsFilePath,
    startedAt: block.startedAt,
    endsAt: block.endsAt,
    websites: block.websites,
    managedBy: block.managedBy,
    metadata: block.metadata,
    scheduledByAgentId: block.scheduledByAgentId,
    canUnblockEarly: writable,
    requiresElevation,
    engine: "hosts-file",
    platform: process.platform,
    supportsElevationPrompt,
    elevationPromptMethod,
    reason: permissionWarning,
  };
}

export async function getSelfControlStatus(
  config: SelfControlPluginConfig = currentConfig,
): Promise<SelfControlStatus> {
  if (nativeBackend) {
    return await nativeBackend.getStatus();
  }
  return await reconcileSelfControlBlockState(config);
}

export async function getCachedSelfControlStatus(
  config: SelfControlPluginConfig = currentConfig,
): Promise<SelfControlStatus> {
  const ttlMs = config.statusCacheTtlMs ?? DEFAULT_STATUS_CACHE_TTL_MS;
  if (statusCache && statusCache.expiresAt > Date.now()) {
    return await statusCache.promise;
  }

  const promise = getSelfControlStatus(config);
  statusCache = {
    expiresAt: Date.now() + ttlMs,
    promise,
  };
  return await promise;
}

export async function getSelfControlPermissionState(
  config: SelfControlPluginConfig = currentConfig,
): Promise<SelfControlPermissionState> {
  if (nativeBackend) {
    return await nativeBackend.getPermissionState();
  }
  const status = await getSelfControlStatus(config);
  const permissionStatus = mapSelfControlStatusToPermissionStatus(status);
  const canRequest =
    permissionStatus === "not-determined" && status.supportsElevationPrompt;

  return {
    id: "website-blocking",
    status: permissionStatus,
    lastChecked: Date.now(),
    canRequest,
    reason: buildSelfControlPermissionReason(status, {
      prompted: false,
      promptSucceeded: false,
    }),
    hostsFilePath: status.hostsFilePath,
    supportsElevationPrompt: status.supportsElevationPrompt,
    elevationPromptMethod: status.elevationPromptMethod,
    promptAttempted: false,
    promptSucceeded: false,
  };
}

export async function requestSelfControlPermission(
  config: SelfControlPluginConfig = currentConfig,
): Promise<SelfControlPermissionState> {
  if (nativeBackend) {
    return await nativeBackend.requestPermission();
  }
  const status = await getSelfControlStatus(config);
  if (!status.hostsFilePath) {
    return await getSelfControlPermissionState(config);
  }

  if (!status.requiresElevation) {
    return await getSelfControlPermissionState(config);
  }

  if (!status.supportsElevationPrompt) {
    return await getSelfControlPermissionState(config);
  }

  try {
    const hostsContent = fs.readFileSync(status.hostsFilePath, "utf8");
    await writeHostsFileContent(status.hostsFilePath, hostsContent, {
      allowElevationPrompt: true,
    });
    resetSelfControlStatusCache();
    const nextStatus = await getSelfControlStatus(config);
    return {
      ...(await getSelfControlPermissionState(config)),
      reason: buildSelfControlPermissionReason(nextStatus, {
        prompted: true,
        promptSucceeded: true,
      }),
      promptAttempted: true,
      promptSucceeded: true,
    };
  } catch (error) {
    return {
      ...(await getSelfControlPermissionState(config)),
      reason: formatFileError(
        error,
        "Eliza could not get administrator/root approval for website blocking.",
      ),
      promptAttempted: true,
      promptSucceeded: false,
    };
  }
}

export async function openSelfControlPermissionLocation(
  config: SelfControlPluginConfig = currentConfig,
): Promise<boolean> {
  const hostsFilePath = await resolveSelfControlHostsFilePath(config);
  if (!hostsFilePath) {
    return false;
  }

  const parentPath = path.dirname(hostsFilePath);
  switch (process.platform) {
    case "darwin":
      await execFileAsync("open", ["-R", hostsFilePath]);
      return true;
    case "win32":
      await execFileAsync("explorer.exe", [`/select,${hostsFilePath}`]);
      return true;
    case "linux":
      await execFileAsync("xdg-open", [parentPath]);
      return true;
    default:
      return false;
  }
}

export async function startSelfControlBlock(
  request: SelfControlBlockRequest,
  config: SelfControlPluginConfig = currentConfig,
): Promise<
  | {
      success: true;
      endsAt: string | null;
    }
  | {
      success: false;
      error: string;
      status?: SelfControlStatus;
    }
> {
  // Dispatch to native backend (iOS/Android) when registered
  if (nativeBackend) {
    resetSelfControlStatusCache();
    return await nativeBackend.startBlock(request);
  }

  const normalizedRequest = normalizeSelfControlBlockRequest(request);
  if (normalizedRequest.success === false) {
    return {
      success: false,
      error: normalizedRequest.error,
    };
  }

  const status = await reconcileSelfControlBlockState(config);
  if (!status.available || !status.hostsFilePath) {
    return {
      success: false,
      error: status.reason ?? "Local website blocking is unavailable.",
      status,
    };
  }

  if (status.active) {
    return {
      success: false,
      error:
        status.endsAt === null
          ? "A website block is already running until you remove it."
          : `A website block is already running until ${status.endsAt}.`,
      status,
    };
  }

  if (!status.canUnblockEarly && !status.supportsElevationPrompt) {
    return {
      success: false,
      error:
        status.reason ??
        "Eliza needs administrator/root access to edit the system hosts file.",
      status,
    };
  }

  const metadata: SelfControlBlockMetadata = {
    version: 1,
    startedAt: new Date().toISOString(),
    endsAt:
      normalizedRequest.request.durationMinutes === null
        ? null
        : new Date(
            Date.now() + normalizedRequest.request.durationMinutes * 60_000,
          ).toISOString(),
    websites: normalizedRequest.request.websites,
    managedBy:
      typeof normalizedRequest.request.metadata?.managedBy === "string" &&
      normalizedRequest.request.metadata.managedBy.trim().length > 0
        ? normalizedRequest.request.metadata.managedBy.trim()
        : null,
    metadata:
      normalizedRequest.request.metadata &&
      typeof normalizedRequest.request.metadata === "object" &&
      !Array.isArray(normalizedRequest.request.metadata)
        ? { ...normalizedRequest.request.metadata }
        : null,
    scheduledByAgentId:
      typeof normalizedRequest.request.scheduledByAgentId === "string" &&
      normalizedRequest.request.scheduledByAgentId.trim().length > 0
        ? normalizedRequest.request.scheduledByAgentId.trim()
        : null,
  };

  try {
    const hostsContent = fs.readFileSync(status.hostsFilePath, "utf8");
    const lineEnding = detectLineEnding(hostsContent);
    const cleanedContent = stripManagedSelfControlBlock(hostsContent).trimEnd();
    const nextContent = [
      cleanedContent,
      cleanedContent ? "" : null,
      buildSelfControlManagedHostsBlock(metadata, lineEnding).trimEnd(),
      "",
    ]
      .filter((part): part is string => part !== null)
      .join(lineEnding);

    await writeHostsFileContent(status.hostsFilePath, nextContent, {
      allowElevationPrompt: true,
    });
  } catch (error) {
    return {
      success: false,
      error: formatFileError(
        error,
        "Eliza failed to update the system hosts file.",
      ),
      status,
    };
  }

  resetSelfControlStatusCache();
  return {
    success: true,
    endsAt: metadata.endsAt,
  };
}

export async function stopSelfControlBlock(
  config: SelfControlPluginConfig = currentConfig,
): Promise<
  | {
      success: true;
      removed: boolean;
      status: SelfControlStatus;
    }
  | {
      success: false;
      error: string;
      status?: SelfControlStatus;
    }
> {
  // Dispatch to native backend (iOS/Android) when registered
  if (nativeBackend) {
    resetSelfControlStatusCache();
    return await nativeBackend.stopBlock();
  }

  const status = await reconcileSelfControlBlockState(config);
  if (!status.available || !status.hostsFilePath) {
    return {
      success: false,
      error: status.reason ?? "Local website blocking is unavailable.",
      status,
    };
  }

  if (!status.active) {
    return {
      success: true,
      removed: false,
      status,
    };
  }

  if (!status.canUnblockEarly && !status.supportsElevationPrompt) {
    return {
      success: false,
      error:
        status.reason ??
        "Eliza needs administrator/root access to edit the system hosts file.",
      status,
    };
  }

  try {
    const hostsContent = fs.readFileSync(status.hostsFilePath, "utf8");
    await clearManagedSelfControlBlock(status.hostsFilePath, hostsContent, {
      allowElevationPrompt: true,
    });
  } catch (error) {
    return {
      success: false,
      error: formatFileError(
        error,
        "Eliza failed to remove the website block from the system hosts file.",
      ),
      status,
    };
  }

  resetSelfControlStatusCache();
  return {
    success: true,
    removed: true,
    status: {
      ...status,
      active: false,
      startedAt: null,
      endsAt: null,
      websites: [],
      managedBy: null,
      metadata: null,
      scheduledByAgentId: null,
    },
  };
}

export function buildSelfControlManagedHostsBlock(
  metadata: SelfControlBlockMetadata,
  lineEnding = "\n",
): string {
  const entries = metadata.websites.flatMap((website) => [
    `0.0.0.0 ${website}`,
    `::1 ${website}`,
  ]);

  return [
    BLOCK_START_MARKER,
    `${BLOCK_METADATA_PREFIX}${JSON.stringify(metadata)}`,
    ...entries,
    BLOCK_END_MARKER,
    "",
  ].join(lineEnding);
}

export function parseSelfControlBlockRequest(
  options?: HandlerOptions,
): { request: SelfControlBlockRequest | null; error?: string } {
  const params = options?.parameters as
    | {
        websites?: string[] | string;
        durationMinutes?: number | string | null;
      }
    | undefined;

  const websites = normalizeWebsiteTargets(
    normalizeStringList(params?.websites) ?? [],
  );

  if (websites.length === 0) {
    return {
      request: null,
      error:
        "Provide at least one public website hostname, such as `x.com` or `twitter.com`.",
    };
  }

  const durationMinutes =
    parseDurationMinutes(params?.durationMinutes) ??
    DEFAULT_DURATION_MINUTES;

  if (
    durationMinutes !== null &&
    (durationMinutes < 1 || durationMinutes > MAX_BLOCK_MINUTES)
  ) {
    return {
      request: null,
      error: `Duration must be between 1 and ${MAX_BLOCK_MINUTES} minutes.`,
    };
  }

  return {
    request: {
      websites,
      durationMinutes,
    },
  };
}

export function normalizeWebsiteTargets(
  rawTargets: readonly string[],
): string[] {
  const deduped = new Set<string>();

  for (const rawTarget of rawTargets) {
    const normalized = normalizeWebsiteTarget(rawTarget);
    if (normalized) {
      deduped.add(normalized);
    }
  }

  return [...deduped];
}

export function formatWebsiteList(websites: readonly string[]): string {
  if (websites.length <= 3) {
    return websites.join(", ");
  }

  const preview = websites.slice(0, 3).join(", ");
  return `${preview}, and ${websites.length - 3} more`;
}

function mapSelfControlStatusToPermissionStatus(
  status: SelfControlStatus,
): PermissionStatus {
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    return "not-applicable";
  }

  if (!status.available) {
    return "denied";
  }

  if (status.available && !status.requiresElevation) {
    return "granted";
  }

  if (status.supportsElevationPrompt) {
    return "not-determined";
  }

  return "denied";
}

function buildSelfControlPermissionReason(
  status: SelfControlStatus,
  options: { prompted: boolean; promptSucceeded: boolean },
): string | undefined {
  if (status.available && !status.requiresElevation) {
    return (
      status.reason ??
      "Eliza can edit the system hosts file directly on this machine."
    );
  }

  if (status.supportsElevationPrompt) {
    if (options.prompted && options.promptSucceeded) {
      return (
        "The approval prompt completed successfully. " +
        "Eliza can ask the OS for administrator/root approval whenever it needs to edit the system hosts file. " +
        "That approval is per operation, so you may see the prompt again when starting or stopping a block."
      );
    }

    return "Eliza can ask the OS for administrator/root approval whenever it needs to edit the system hosts file.";
  }

  return "Eliza cannot raise an administrator/root prompt for website blocking on this machine. Open the hosts file location and change ownership or run Eliza with elevated access.";
}

function normalizeSelfControlBlockRequest(
  request: SelfControlBlockRequest,
):
  | { success: true; request: SelfControlBlockRequest }
  | { success: false; error: string } {
  const websites = normalizeWebsiteTargets(request.websites);
  if (websites.length === 0) {
    return {
      success: false,
      error:
        "Provide at least one public website hostname, such as `x.com` or `twitter.com`.",
    };
  }

  const durationMinutes = request.durationMinutes;
  if (
    durationMinutes !== null &&
    (!Number.isFinite(durationMinutes) ||
      durationMinutes < 1 ||
      durationMinutes > MAX_BLOCK_MINUTES)
  ) {
    return {
      success: false,
      error: `Duration must be between 1 and ${MAX_BLOCK_MINUTES} minutes.`,
    };
  }

  return {
    success: true,
    request: {
      websites,
      durationMinutes,
      metadata:
        request.metadata &&
        typeof request.metadata === "object" &&
        !Array.isArray(request.metadata)
          ? { ...request.metadata }
          : null,
      scheduledByAgentId:
        typeof request.scheduledByAgentId === "string" &&
        request.scheduledByAgentId.trim().length > 0
          ? request.scheduledByAgentId.trim()
          : null,
    },
  };
}

async function clearManagedSelfControlBlock(
  hostsFilePath: string,
  hostsContent: string,
  options: { allowElevationPrompt: boolean },
): Promise<void> {
  const nextContent = stripManagedSelfControlBlock(hostsContent);
  await writeHostsFileContent(hostsFilePath, nextContent, options);
}

function extractManagedSelfControlBlock(content: string): {
  startedAt: string | null;
  endsAt: string | null;
  websites: string[];
  managedBy: string | null;
  metadata: Record<string, unknown> | null;
  scheduledByAgentId: string | null;
} | null {
  const pattern = new RegExp(
    `${escapeRegExp(BLOCK_START_MARKER)}[\\s\\S]*?${escapeRegExp(BLOCK_END_MARKER)}`,
  );
  const match = content.match(pattern);
  if (!match) return null;

  const block = match[0];
  const metadata = parseManagedBlockMetadata(block);
  const websites =
    metadata?.websites.length &&
    normalizeWebsiteTargets(metadata.websites).length
      ? normalizeWebsiteTargets(metadata.websites)
      : extractManagedBlockWebsiteTargets(block);

  return {
    startedAt: metadata?.startedAt ?? null,
    endsAt: metadata?.endsAt ?? null,
    websites,
    managedBy:
      metadata?.managedBy && typeof metadata.managedBy === "string"
        ? metadata.managedBy
        : null,
    metadata:
      metadata?.metadata &&
      typeof metadata.metadata === "object" &&
      !Array.isArray(metadata.metadata)
        ? metadata.metadata
        : null,
    scheduledByAgentId:
      typeof metadata?.scheduledByAgentId === "string" &&
      metadata.scheduledByAgentId.trim().length > 0
        ? metadata.scheduledByAgentId.trim()
        : null,
  };
}

function parseManagedBlockMetadata(
  block: string,
): SelfControlBlockMetadata | null {
  const metadataLine = block.match(/^# eliza-selfcontrol (.+)$/m);
  if (!metadataLine?.[1]) return null;

  try {
    const parsed = JSON.parse(
      metadataLine[1],
    ) as Partial<SelfControlBlockMetadata>;
    const websites = Array.isArray(parsed.websites)
      ? normalizeWebsiteTargets(
          parsed.websites.filter(
            (website): website is string => typeof website === "string",
          ),
        )
      : [];

    return {
      version: 1,
      startedAt:
        typeof parsed.startedAt === "string"
          ? parsed.startedAt
          : new Date().toISOString(),
      endsAt:
        typeof parsed.endsAt === "string"
          ? normalizeIsoDate(parsed.endsAt)
          : null,
      websites,
      managedBy:
        typeof parsed.managedBy === "string" &&
        parsed.managedBy.trim().length > 0
          ? parsed.managedBy.trim()
          : null,
      metadata:
        parsed.metadata &&
        typeof parsed.metadata === "object" &&
        !Array.isArray(parsed.metadata)
          ? (parsed.metadata as Record<string, unknown>)
          : null,
      scheduledByAgentId:
        typeof parsed.scheduledByAgentId === "string" &&
        parsed.scheduledByAgentId.trim().length > 0
          ? parsed.scheduledByAgentId.trim()
          : null,
    };
  } catch {
    return null;
  }
}

function extractManagedBlockWebsiteTargets(block: string): string[] {
  const websites = Array.from(
    block.matchAll(/^(?:0\.0\.0\.0|::1)\s+([^\s#]+)$/gm),
  )
    .map((match) => match[1])
    .filter((website): website is string => typeof website === "string");
  return normalizeWebsiteTargets(websites);
}

function stripManagedSelfControlBlock(content: string): string {
  const pattern = new RegExp(
    `(?:\\r?\\n)?${escapeRegExp(BLOCK_START_MARKER)}[\\s\\S]*?${escapeRegExp(BLOCK_END_MARKER)}(?:\\r?\\n)?`,
    "g",
  );
  const stripped = content.replace(pattern, "\n");
  const lineEnding = detectLineEnding(content);
  const normalized = stripped
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return normalized ? `${normalized}${lineEnding}` : "";
}

function canWriteHostsFile(hostsFilePath: string): boolean {
  try {
    fs.accessSync(hostsFilePath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveSelfControlElevationPromptMethod(
  platform: NodeJS.Platform = process.platform,
): SelfControlElevationMethod | null {
  switch (platform) {
    case "darwin":
      return hasCommandOnPath("osascript", platform) ? "osascript" : null;
    case "linux":
      return hasCommandOnPath("pkexec", platform) ? "pkexec" : null;
    case "win32":
      return hasCommandOnPath("powershell", platform) ||
        hasCommandOnPath("powershell.exe", platform)
        ? "powershell-runas"
        : null;
    default:
      return null;
  }
}

export function buildPrivilegedHostsWriteInvocation(
  sourcePath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
  workerScriptPath?: string,
): PrivilegedHostsWriteInvocation | null {
  switch (platform) {
    case "darwin":
      return {
        command: "osascript",
        args: [
          "-e",
          "on run argv",
          "-e",
          "set src to quoted form of item 1 of argv",
          "-e",
          "set dst to quoted form of item 2 of argv",
          "-e",
          'do shell script "/usr/bin/install -m 644 -- " & src & " " & dst with administrator privileges',
          "-e",
          "end run",
          "--",
          sourcePath,
          targetPath,
        ],
      };
    case "linux":
      return {
        command: "pkexec",
        args: ["/usr/bin/install", "-m", "644", "--", sourcePath, targetPath],
      };
    case "win32":
      if (!workerScriptPath) {
        return null;
      }
      return {
        command: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          [
            `$process = Start-Process -FilePath ${quotePowerShell("powershell")}`,
            "-Verb RunAs",
            "-WindowStyle Hidden",
            "-Wait",
            "-PassThru",
            `-ArgumentList @(${[
              "-NoProfile",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              workerScriptPath,
              "-Source",
              sourcePath,
              "-Target",
              targetPath,
            ]
              .map(quotePowerShell)
              .join(", ")})`,
            ";",
            "exit $process.ExitCode",
          ].join(" "),
        ],
        workerScriptContent: [
          "param(",
          "  [Parameter(Mandatory = $true)][string]$Source,",
          "  [Parameter(Mandatory = $true)][string]$Target",
          ")",
          "$ErrorActionPreference = 'Stop'",
          "Copy-Item -LiteralPath $Source -Destination $Target -Force",
          "",
        ].join("\n"),
      };
    default:
      return null;
  }
}

function defaultHostsFilePath(): string {
  if (process.platform === "win32") {
    const root =
      process.env.SystemRoot?.trim() ||
      process.env.WINDIR?.trim() ||
      "C:\\Windows";
    return path.join(root, "System32", "drivers", "etc", "hosts");
  }

  return "/etc/hosts";
}

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, os.homedir()));
  }

  return path.resolve(trimmed);
}

function detectLineEnding(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function buildElevationReason(supportsElevationPrompt: boolean): string {
  return supportsElevationPrompt
    ? "Eliza needs administrator/root access to edit the system hosts file, and can ask the OS for approval when you start or stop a block."
    : "Eliza needs administrator/root access to edit the system hosts file.";
}

function hasCommandOnPath(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const isWindows = platform === "win32";
  if (path.isAbsolute(command)) {
    return fs.existsSync(command);
  }

  const pathValue = process.env.PATH ?? "";
  const pathDelimiter = isWindows ? ";" : ":";
  const directories = pathValue
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const candidates = isWindows
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

  return directories.some((directory) =>
    candidates.some((candidate) =>
      fs.existsSync(path.join(directory, candidate)),
    ),
  );
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ((error as NodeJS.ErrnoException).code === "EACCES" ||
        (error as NodeJS.ErrnoException).code === "EPERM"),
  );
}

async function writeHostsFileContent(
  hostsFilePath: string,
  nextContent: string,
  options: { allowElevationPrompt: boolean },
): Promise<void> {
  try {
    fs.writeFileSync(hostsFilePath, nextContent, "utf8");
    return;
  } catch (error) {
    if (!options.allowElevationPrompt || !isPermissionError(error)) {
      throw error;
    }
  }

  await writeHostsFileContentWithElevation(hostsFilePath, nextContent);
}

async function writeHostsFileContentWithElevation(
  hostsFilePath: string,
  nextContent: string,
): Promise<void> {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), PRIVILEGED_WRITE_TMP_PREFIX),
  );
  const tempHostsPath = path.join(tempRoot, "hosts");
  const workerScriptPath = path.join(tempRoot, WINDOWS_WORKER_SCRIPT_NAME);

  try {
    fs.writeFileSync(tempHostsPath, nextContent, "utf8");
    const invocation = buildPrivilegedHostsWriteInvocation(
      tempHostsPath,
      hostsFilePath,
      process.platform,
      workerScriptPath,
    );
    if (!invocation) {
      throw new Error(buildElevationReason(false));
    }

    if (invocation.workerScriptContent) {
      fs.writeFileSync(
        workerScriptPath,
        invocation.workerScriptContent,
        "utf8",
      );
    }

    await execFileAsync(invocation.command, invocation.args);
  } catch (error) {
    if (
      error instanceof Error &&
      /^Eliza needs administrator\/root access/i.test(error.message)
    ) {
      throw error;
    }

    throw new Error(
      `${buildElevationReason(true)} ${extractCommandFailureMessage(error)}`,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function normalizeWebsiteTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim().replace(/[),.!?]+$/g, "");
  if (!trimmed) return null;

  let hostname = trimmed;
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    hostname = new URL(candidate).hostname;
  } catch {
    hostname = trimmed;
  }

  const asciiHostname = domainToASCII(
    hostname.toLowerCase().replace(/\.$/, ""),
  );
  if (!asciiHostname) return null;
  if (asciiHostname === "localhost" || asciiHostname.endsWith(".local")) {
    return null;
  }
  if (!asciiHostname.includes(".")) return null;
  if (isIP(asciiHostname) !== 0) return null;

  const labels = asciiHostname.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }

  return asciiHostname;
}

function normalizeStringList(
  value: string[] | string | undefined,
): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return null;
}

function parseDurationMinutes(
  value: number | string | null | undefined,
): number | null | undefined {
  if (value === null) return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return undefined;
    if (
      trimmed === "indefinite" ||
      trimmed === "manual" ||
      trimmed === "until-unblocked"
    ) {
      return null;
    }

    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }

  return undefined;
}

function normalizeIsoDate(rawDate: string): string | null {
  const parsed = new Date(rawDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatFileError(error: unknown, fallback: string): string {
  if (isPermissionError(error)) {
    return "Eliza needs administrator/root access to edit the system hosts file.";
  }

  if (
    error instanceof Error &&
    /^Eliza needs administrator\/root access/i.test(error.message)
  ) {
    return error.message;
  }

  return error instanceof Error && error.message
    ? `${fallback} ${error.message}`
    : fallback;
}

function extractCommandFailureMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "The OS denied or canceled the elevation request.";
  }

  const stderr =
    "stderr" in error
      ? typeof error.stderr === "string"
        ? error.stderr.trim()
        : Buffer.isBuffer(error.stderr)
          ? error.stderr.toString("utf8").trim()
          : ""
      : "";
  if (stderr) {
    return stderr;
  }

  const message = error instanceof Error ? error.message.trim() : "";
  if (message) {
    return message;
  }

  return "The OS denied or canceled the elevation request.";
}
