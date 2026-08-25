/** Coordinates Steward platform-user provisioning and lifecycle calls for Cloud services. */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { resolveServerStewardApiUrlFromEnv } from "../steward-url";
import { logger } from "../utils/logger";

export interface StewardPlatformProvisionUserInput {
  email: string;
  emailVerified?: boolean;
  name?: string | null;
}

export interface StewardPlatformProvisionUserResult {
  userId: string;
  isNew: boolean;
}

export interface StewardPlatformUserLifecycleResult {
  userId: string;
}

type StewardPlatformUserResponse =
  | {
      ok: true;
      data?: { userId?: string; isNew?: boolean };
      userId?: string;
      isNew?: boolean;
    }
  | {
      ok: false;
      error?: string;
    };

async function readStewardPlatformUserResponse(
  response: Response,
): Promise<StewardPlatformUserResponse> {
  try {
    return (await response.json()) as StewardPlatformUserResponse;
  } catch (error) {
    // error-policy:J2 context-adding rethrow; malformed Steward responses are upstream failures, not absent payloads.
    throw new Error(
      `Steward /platform/users returned ${response.status} and its JSON body could not be parsed`,
      { cause: error },
    );
  }
}

export function getStewardApiUrl(): string {
  return resolveServerStewardApiUrlFromEnv(getCloudAwareEnv());
}

export function getStewardPlatformKey(): string {
  const key = (getCloudAwareEnv().STEWARD_PLATFORM_KEYS ?? "").split(",")[0]?.trim();
  if (!key) {
    throw new Error("STEWARD_PLATFORM_KEYS is not configured");
  }
  return key;
}

export function isStewardPlatformConfigured(): boolean {
  try {
    return getStewardPlatformKey().length > 0;
  } catch {
    // error-policy:J4 explicit availability probe; callers use false to hide Steward-only flows when config is absent.
    return false;
  }
}

export async function provisionStewardPlatformUser(
  input: StewardPlatformProvisionUserInput,
): Promise<StewardPlatformProvisionUserResult> {
  const email = input.email.toLowerCase().trim();
  const response = await fetch(`${getStewardApiUrl()}/platform/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Steward-Platform-Key": getStewardPlatformKey(),
    },
    body: JSON.stringify({
      email,
      emailVerified: input.emailVerified ?? false,
      name: input.name ?? undefined,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  const payload = await readStewardPlatformUserResponse(response);

  if (!response.ok || !payload.ok) {
    const errorMessage =
      payload && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Steward /platform/users returned ${response.status}`;
    throw new Error(errorMessage);
  }

  const userId = payload.data?.userId ?? payload.userId;
  const isNew = payload.data?.isNew ?? payload.isNew ?? false;

  if (!userId) {
    throw new Error("Steward /platform/users did not return a userId");
  }

  logger.info("[StewardPlatformUsers] Provisioned Steward user", {
    email,
    stewardUserId: userId,
    isNew,
  });

  return { userId, isNew };
}

async function mutateStewardPlatformUser(
  userId: string,
  method: "PATCH" | "DELETE",
  suffix = "",
  body?: Record<string, unknown>,
): Promise<StewardPlatformUserLifecycleResult> {
  const response = await fetch(
    `${getStewardApiUrl()}/platform/users/${encodeURIComponent(userId)}${suffix}`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": getStewardPlatformKey(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    },
  );
  // A replayed purge after Steward already removed the identity is complete,
  // not an operator-visible failure. Deactivation still treats 404 as an error.
  if (method === "DELETE" && response.status === 404) {
    return { userId };
  }
  const payload = await readStewardPlatformUserResponse(response);
  if (!response.ok || !payload.ok) {
    const message =
      "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Steward user lifecycle request returned ${response.status}`;
    throw new Error(message);
  }
  return { userId };
}

/** Immediately prevents new Steward sessions while a deletion request waits for purge. */
export async function deactivateStewardPlatformUser(
  userId: string,
): Promise<StewardPlatformUserLifecycleResult> {
  return await mutateStewardPlatformUser(userId, "PATCH", "/deactivate", {
    deactivated: true,
  });
}

async function deleteStewardPersonalTenant(userId: string): Promise<void> {
  const tenantId = `personal-${userId}`;
  const response = await fetch(
    `${getStewardApiUrl()}/platform/tenants/${encodeURIComponent(tenantId)}`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": getStewardPlatformKey(),
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status === 404) return;
  const payload = await readStewardPlatformUserResponse(response);
  if (!response.ok || !payload.ok) {
    const message =
      "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Steward personal tenant deletion returned ${response.status}`;
    throw new Error(message);
  }
}

/** Permanently removes the Steward personal tenant and identity in that order. */
export async function deleteStewardPlatformUser(
  userId: string,
): Promise<StewardPlatformUserLifecycleResult> {
  await deleteStewardPersonalTenant(userId);
  return await mutateStewardPlatformUser(userId, "DELETE");
}
