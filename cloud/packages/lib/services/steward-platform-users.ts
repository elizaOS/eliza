import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";
import { resolveServerStewardApiUrlFromEnv } from "@/lib/steward-url";
import { logger } from "@/lib/utils/logger";

export interface StewardPlatformProvisionUserInput {
  email: string;
  emailVerified?: boolean;
  name?: string | null;
}

export interface StewardPlatformProvisionUserResult {
  userId: string;
  isNew: boolean;
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

  const payload = (await response.json().catch(() => null)) as StewardPlatformUserResponse | null;

  if (!response.ok || !payload?.ok) {
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
