import { execFile } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { domainToASCII } from "node:url";
import { promisify } from "node:util";
import type { HandlerOptions } from "@elizaos/core";
import type { PermissionState, PermissionStatus } from "./permissions.js";

const BLOCK_START_MARKER = "# >>> eliza-selfcontrol >>>";
const BLOCK_END_MARKER = "# <<< eliza-selfcontrol <<<";
const BLOCK_METADATA_PREFIX = "# eliza-selfcontrol ";
const DEFAULT_STATUS_CACHE_TTL_MS = 5_000;

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
  startBlock(
    request: SelfControlBlockRequest,
  ): Promise<
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
  validateSystemResolution?: boolean;
  resolvedAddressLookup?: (website: string) => Promise<string[]>;
}

export interface SelfControlStatus {
  available: boolean;
  active: boolean;
  hostsFilePath: string | null;
  startedAt: string | null;
  endsAt: string | null;
  websites: string[];
  blockedWebsites: string[];
  allowedWebsites: string[];
  requestedWebsites: string[];
  matchMode: SelfControlBlockMatchMode;
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

export type SelfControlBlockMatchMode = "exact" | "subdomain";

export interface SelfControlBlockPolicy {
  requestedWebsites: string[];
  blockedWebsites: string[];
  allowedWebsites: string[];
  matchMode: SelfControlBlockMatchMode;
}

export interface SelfControlBlockMetadata {
  version: 1;
  startedAt: string;
  endsAt: string | null;
  websites: string[];
  requestedWebsites?: string[];
  blockedWebsites?: string[];
  allowedWebsites?: string[];
  matchMode?: SelfControlBlockMatchMode;
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

const X_TWITTER_REQUESTED_HOSTS = ["x.com", "twitter.com"] as const;
const X_TWITTER_BLOCKED_HOSTS = [
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "t.co",
  "abs.twimg.com",
  "pbs.twimg.com",
  "video.twimg.com",
  "ton.twimg.com",
  "platform.twitter.com",
  "tweetdeck.twitter.com",
] as const;
const X_TWITTER_ALLOWED_HOSTS = ["api.x.com", "api.twitter.com"] as const;
const REDDIT_REQUESTED_HOSTS = ["reddit.com"] as const;
const REDDIT_BLOCKED_HOSTS = [
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "m.reddit.com",
  "np.reddit.com",
  "i.redd.it",
  "v.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
] as const;
const GOOGLE_NEWS_REQUESTED_HOSTS = ["news.google.com"] as const;
const GOOGLE_NEWS_BLOCKED_HOSTS = ["news.google.com"] as const;
const GOOGLE_NEWS_ALLOWED_HOSTS = [
  "accounts.google.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
  "www.googleapis.com",
] as const;

const WEBSITE_BLOCK_POLICY_GROUPS = [
  {
    requestedHosts: X_TWITTER_REQUESTED_HOSTS,
    blockedHosts: X_TWITTER_BLOCKED_HOSTS,
    allowedHosts: X_TWITTER_ALLOWED_HOSTS,
  },
  {
    requestedHosts: REDDIT_REQUESTED_HOSTS,
    blockedHosts: REDDIT_BLOCKED_HOSTS,
    allowedHosts: [],
  },
  {
    requestedHosts: GOOGLE_NEWS_REQUESTED_HOSTS,
    blockedHosts: GOOGLE_NEWS_BLOCKED_HOSTS,
    allowedHosts: GOOGLE_NEWS_ALLOWED_HOSTS,
  },
] as const;

const WEBSITE_BLOCK_POLICY_LOOKUP = new Map<
  string,
  (typeof WEBSITE_BLOCK_POLICY_GROUPS)[number]
>(
  WEBSITE_BLOCK_POLICY_GROUPS.flatMap((group) =>
    group.requestedHosts.map((hostname) => [hostname, group] as const),
  ),
);

const EMPTY_SELF_CONTROL_BLOCK_POLICY: SelfControlBlockPolicy = {
  requestedWebsites: [],
  blockedWebsites: [],
  allowedWebsites: [],
  matchMode: "exact",
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

export function buildSelfControlBlockPolicy(
  requestedWebsites: readonly string[],
): SelfControlBlockPolicy {
  const normalizedRequestedWebsites =
    normalizeWebsiteTargets(requestedWebsites);
  const blockedWebsites = new Set<string>();
  const allowedWebsites = new Set<string>();

  for (const website of normalizedRequestedWebsites) {
    blockedWebsites.add(website);

    if (shouldAddWwwVariant(website)) {
      blockedWebsites.add(`www.${website}`);
    }

    const policyGroup = WEBSITE_BLOCK_POLICY_LOOKUP.get(website);
    if (policyGroup) {
      for (const blockedHost of policyGroup.blockedHosts) {
        blockedWebsites.add(blockedHost);
      }
      for (const allowedHost of policyGroup.allowedHosts) {
        allowedWebsites.add(allowedHost);
      }
    }
  }

  return {
    requestedWebsites: normalizedRequestedWebsites,
    blockedWebsites: normalizeWebsiteTargets([...blockedWebsites]),
    allowedWebsites: normalizeWebsiteTargets([...allowedWebsites]),
    matchMode: "exact",
  };
}

export function isWebsiteBlockedByPolicy(
  policy: Pick<
    SelfControlBlockPolicy,
    "blockedWebsites" | "allowedWebsites" | "matchMode"
  >,
  queryWebsite: string,
): boolean {
  const normalizedQueryWebsite = normalizeWebsiteTarget(queryWebsite);
  if (!normalizedQueryWebsite) {
    return false;
  }

  if (
    policy.allowedWebsites.some(
      (allowedWebsite) => normalizedQueryWebsite === allowedWebsite,
    )
  ) {
    return false;
  }

  return policy.blockedWebsites.some((blockedWebsite) =>
    matchesWebsiteBlockTarget(
      normalizedQueryWebsite,
      blockedWebsite,
      policy.matchMode,
    ),
  );
}

export function cancelSelfControlExpiryTimer(): void {
  // Timed website unblocks are scheduled through Eliza tasks now.
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
      ...EMPTY_SELF_CONTROL_BLOCK_POLICY,
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
      ...EMPTY_SELF_CONTROL_BLOCK_POLICY,
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
      ...EMPTY_SELF_CONTROL_BLOCK_POLICY,
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

  if (shouldValidateSelfControlSystemResolution(hostsFilePath, config)) {
    const ineffectiveTargets = await findIneffectiveSelfControlTargets(
      block.websites,
      config,
    );
    if (ineffectiveTargets.length > 0) {
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
          ...EMPTY_SELF_CONTROL_BLOCK_POLICY,
          managedBy: null,
          metadata: null,
          scheduledByAgentId: null,
          canUnblockEarly: true,
          requiresElevation: false,
          engine: "hosts-file",
          platform: process.platform,
          supportsElevationPrompt,
          elevationPromptMethod,
          reason:
            "Eliza removed a stale website block because these websites were " +
            `still resolving outside loopback on this machine: ${ineffectiveTargets.join(", ")}.`,
        };
      }

      return {
        available: true,
        active: false,
        hostsFilePath,
        startedAt: null,
        endsAt: null,
        websites: [],
        ...EMPTY_SELF_CONTROL_BLOCK_POLICY,
        managedBy: null,
        metadata: null,
        scheduledByAgentId: null,
        canUnblockEarly: false,
        requiresElevation: true,
        engine: "hosts-file",
        platform: process.platform,
        supportsElevationPrompt,
        elevationPromptMethod,
        reason: supportsElevationPrompt
          ? "Eliza found stale website-block entries that are not actually blocking traffic on this machine, and it still needs administrator/root approval to remove them."
          : "Eliza found stale website-block entries that are not actually blocking traffic on this machine, but it cannot remove them without administrator/root access.",
      };
    }
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
          ...EMPTY_SELF_CONTROL_BLOCK_POLICY,
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
        websites: block.requestedWebsites ?? block.websites,
        blockedWebsites: block.websites,
        allowedWebsites: block.allowedWebsites ?? [],
        requestedWebsites: block.requestedWebsites ?? block.websites,
        matchMode: block.matchMode ?? "exact",
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
    websites: block.requestedWebsites ?? block.websites,
    blockedWebsites: block.websites,
    allowedWebsites: block.allowedWebsites ?? [],
    requestedWebsites: block.requestedWebsites ?? block.websites,
    matchMode: block.matchMode ?? "exact",
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

  const policy = buildSelfControlBlockPolicy(
    normalizedRequest.request.websites,
  );

  const metadata: SelfControlBlockMetadata = {
    version: 1,
    startedAt: new Date().toISOString(),
    endsAt:
      normalizedRequest.request.durationMinutes === null
        ? null
        : new Date(
            Date.now() + normalizedRequest.request.durationMinutes * 60_000,
          ).toISOString(),
    websites: policy.blockedWebsites,
    requestedWebsites: normalizedRequest.request.websites,
    blockedWebsites: policy.blockedWebsites,
    allowedWebsites: policy.allowedWebsites,
    matchMode: policy.matchMode,
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

  if (shouldValidateSelfControlSystemResolution(status.hostsFilePath, config)) {
    const ineffectiveTargets = await findIneffectiveSelfControlTargets(
      metadata.websites,
      config,
    );
    if (ineffectiveTargets.length > 0) {
      try {
        const currentHostsContent = fs.readFileSync(
          status.hostsFilePath,
          "utf8",
        );
        await clearManagedSelfControlBlock(
          status.hostsFilePath,
          currentHostsContent,
          {
            allowElevationPrompt: true,
          },
        );
      } catch {
        // If rollback fails we still surface the validation failure instead of
        // falsely reporting success.
      }

      return {
        success: false,
        error:
          "Eliza updated the system hosts file, but these websites still " +
          `resolved outside loopback on this machine: ${ineffectiveTargets.join(", ")}. ` +
          "The website block was rolled back because it would not be effective.",
      };
    }
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
  const blockedWebsites =
    metadata.blockedWebsites && metadata.blockedWebsites.length > 0
      ? metadata.blockedWebsites
      : metadata.websites;
  const entries = blockedWebsites.flatMap((website) => [
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

export function parseSelfControlBlockRequest(options?: HandlerOptions): {
  request: SelfControlBlockRequest | null;
  error?: string;
} {
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

  const hasDurationMinutes =
    params !== undefined && Object.hasOwn(params, "durationMinutes");
  const parsedDurationMinutes = parseDurationMinutes(params?.durationMinutes);
  if (hasDurationMinutes && parsedDurationMinutes === undefined) {
    return {
      request: null,
      error:
        "Duration must be a positive number of minutes, or null for a manual block.",
    };
  }

  const durationMinutes =
    parsedDurationMinutes === undefined ? null : parsedDurationMinutes;

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

function shouldAddWwwVariant(target: string): boolean {
  const labels = target.split(".");
  return labels.length === 2 && labels[0] !== "www";
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
  requestedWebsites: string[] | null;
  blockedWebsites: string[];
  allowedWebsites: string[];
  matchMode: SelfControlBlockMatchMode;
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
  const blockedWebsites =
    metadata?.blockedWebsites?.length &&
    normalizeWebsiteTargets(metadata.blockedWebsites).length
      ? normalizeWebsiteTargets(metadata.blockedWebsites)
      : metadata?.websites.length &&
          normalizeWebsiteTargets(metadata.websites).length
        ? normalizeWebsiteTargets(metadata.websites)
        : extractManagedBlockWebsiteTargets(block);

  return {
    startedAt: metadata?.startedAt ?? null,
    endsAt: metadata?.endsAt ?? null,
    websites: blockedWebsites,
    requestedWebsites:
      metadata?.requestedWebsites &&
      normalizeWebsiteTargets(metadata.requestedWebsites).length > 0
        ? normalizeWebsiteTargets(metadata.requestedWebsites)
        : null,
    blockedWebsites,
    allowedWebsites:
      metadata?.allowedWebsites &&
      normalizeWebsiteTargets(metadata.allowedWebsites).length > 0
        ? normalizeWebsiteTargets(metadata.allowedWebsites)
        : [],
    matchMode: metadata?.matchMode ?? "exact",
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
    const requestedWebsites = Array.isArray(parsed.requestedWebsites)
      ? normalizeWebsiteTargets(
          parsed.requestedWebsites.filter(
            (website): website is string => typeof website === "string",
          ),
        )
      : [];
    const blockedWebsites = Array.isArray(parsed.blockedWebsites)
      ? normalizeWebsiteTargets(
          parsed.blockedWebsites.filter(
            (website): website is string => typeof website === "string",
          ),
        )
      : websites;
    const allowedWebsites = Array.isArray(parsed.allowedWebsites)
      ? normalizeWebsiteTargets(
          parsed.allowedWebsites.filter(
            (website): website is string => typeof website === "string",
          ),
        )
      : [];
    const matchMode: SelfControlBlockMatchMode =
      parsed.matchMode === "subdomain" ? "subdomain" : "exact";

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
      requestedWebsites,
      blockedWebsites,
      allowedWebsites,
      matchMode,
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

function matchesWebsiteBlockTarget(
  queryWebsite: string,
  blockedWebsite: string,
  matchMode: SelfControlBlockMatchMode,
): boolean {
  if (queryWebsite === blockedWebsite) {
    return true;
  }

  return (
    matchMode === "subdomain" && queryWebsite.endsWith(`.${blockedWebsite}`)
  );
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

function shouldValidateSelfControlSystemResolution(
  hostsFilePath: string,
  config: SelfControlPluginConfig,
): boolean {
  if (config.validateSystemResolution === true) {
    return true;
  }
  if (config.validateSystemResolution === false) {
    return false;
  }
  return path.resolve(hostsFilePath) === path.resolve(defaultHostsFilePath());
}

async function findIneffectiveSelfControlTargets(
  websites: readonly string[],
  config: SelfControlPluginConfig,
): Promise<string[]> {
  const ineffective: string[] = [];

  for (const website of normalizeWebsiteTargets(websites)) {
    const addresses = await lookupResolvedAddressesForWebsiteBlock(
      website,
      config,
    );
    if (
      addresses.length === 0 ||
      addresses.some((address) => !isWebsiteBlockSinkholeAddress(address))
    ) {
      ineffective.push(website);
    }
  }

  return ineffective;
}

async function lookupResolvedAddressesForWebsiteBlock(
  website: string,
  config: SelfControlPluginConfig,
): Promise<string[]> {
  if (typeof config.resolvedAddressLookup === "function") {
    return await config.resolvedAddressLookup(website);
  }

  if (process.platform === "darwin") {
    try {
      const result = await execFileAsync("/usr/bin/dscacheutil", [
        "-q",
        "host",
        "-a",
        "name",
        website,
      ]);
      return parseResolvedAddressesFromDscacheutilOutput(result.stdout);
    } catch {
      // Fall back to dns.lookup below.
    }
  }

  try {
    const results = await dnsLookup(website, {
      all: true,
      verbatim: true,
    });
    return [...new Set(results.map((entry) => entry.address))];
  } catch {
    return [];
  }
}

export function parseResolvedAddressesFromDscacheutilOutput(
  output: string,
): string[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .flatMap((line) => {
          const match = line.match(/^(?:ip|ipv6)_address:\s+(\S+)$/i);
          return match?.[1] ? [match[1]] : [];
        }),
    ),
  ];
}

export function isWebsiteBlockSinkholeAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  return (
    normalized === "0.0.0.0" ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.") ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1"
  );
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
  const trimmed = rawTarget
    .slice(0, 4096)
    .trim()
    .replace(/[),.!?]{1,64}$/g, "");
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
    const trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed.replace(/'/g, '"'));
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (item): item is string => typeof item === "string",
          );
        }
      } catch {
        // Fall through to the delimiter-based parser below for malformed
        // planner output such as "['twitter.com', 'reddit.com']".
      }
    }
    return trimmed
      .slice(0, 10_000)
      .split(/[,\n]/)
      .map((item) => item.trim().slice(0, 1024))
      .map((item) => item.replace(/^[[\]'"]{1,32}|[[\]'"]{1,32}$/g, ""))
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
