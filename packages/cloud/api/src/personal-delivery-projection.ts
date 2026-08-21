/**
 * Per-sender account projection for Personal Shared connector turns.
 *
 * The Durable Object absorbs repeat Postgres/Hyperdrive bootstrap while the
 * account still routes to Shared. Dedicated targets are deliberately never
 * cached: their lifecycle and bridge fields remain authoritative in Postgres.
 * Identity writers and tier cutover explicitly delete the sender projection;
 * a one-hour hard expiry is the final safety bound, not the coherence model.
 *
 * The projection is an accelerator, never a gate: a slow, failed, or
 * malformed projection read degrades to the canonical database resolver in
 * the same request, and only a both-path failure surfaces as the typed
 * `PersonalDeliveryAccountResolutionError`.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import {
  PERSONAL_DELIVERY_PROJECTION_INVALIDATE_PATH,
  PERSONAL_DELIVERY_PROJECTION_RESOLVE_PATH,
  personalDeliveryProjectionObjectName,
} from "@/lib/services/eliza-app/personal-delivery-projection-contract";
import type {
  PersonalDeliveryInput,
  PersonalDeliveryResult,
} from "@/lib/services/eliza-app/user-service";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CACHE_KEY = "shared-account";
const CACHE_TTL_MS = 60 * 60_000;
// A projection read slower than this bound is worse than the canonical
// indexed Postgres statement it replaces, so the caller stops waiting and
// resolves directly instead of letting a slow Durable Object own the tail.
const PROJECTION_RESOLVE_TIMEOUT_MS = 1_500;

const SAFE_PROJECTION_FAILURE_NAMES = new Set([
  "AbortError",
  "ApiError",
  "Error",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
]);

function safeProjectionFailureName(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  return SAFE_PROJECTION_FAILURE_NAMES.has(name) ? name : "OtherError";
}

/**
 * Raised when both the sender projection and the canonical database resolver
 * failed for one turn. Carries only tenant-safe classification (never SQL or
 * provider payloads) so the internal route can emit an actionable failure
 * name instead of a bare `Error`.
 */
export class PersonalDeliveryAccountResolutionError extends Error {
  readonly projectionFailure: string;

  constructor(projectionFailure: string, cause: unknown) {
    super("Personal delivery account resolution failed", { cause });
    this.name = "PersonalDeliveryAccountResolutionError";
    this.projectionFailure = projectionFailure;
  }
}

interface SharedAccountProjection {
  profileKey: string;
  userId: string;
  organizationId: string;
  expiresAt: number;
}

interface PersonalDeliveryResolver {
  resolvePersonalDelivery(
    params: PersonalDeliveryInput,
  ): Promise<PersonalDeliveryResult>;
}

function boundedText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalText(value: unknown, max = 512): boolean {
  return (
    value === undefined || (typeof value === "string" && value.length <= max)
  );
}

export function isPersonalDeliveryInput(
  value: unknown,
): value is PersonalDeliveryInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.platform === "telegram") {
    return (
      boundedText(candidate.telegramId, 20) &&
      /^\d{1,20}$/.test(candidate.telegramId) &&
      optionalText(candidate.username) &&
      optionalText(candidate.firstName) &&
      optionalText(candidate.displayName)
    );
  }
  if (candidate.platform === "discord") {
    return (
      boundedText(candidate.discordId, 32) &&
      /^\d{1,32}$/.test(candidate.discordId) &&
      boundedText(candidate.username) &&
      (candidate.globalName === null || optionalText(candidate.globalName)) &&
      (candidate.avatarUrl === null || optionalText(candidate.avatarUrl, 2_048))
    );
  }
  if (candidate.platform === "phone") {
    return (
      boundedText(candidate.phoneNumber, 16) &&
      /^\+[1-9]\d{6,14}$/.test(candidate.phoneNumber)
    );
  }
  return false;
}

function senderId(input: PersonalDeliveryInput): string {
  return input.platform === "telegram"
    ? input.telegramId.trim()
    : input.platform === "discord"
      ? input.discordId.trim()
      : input.phoneNumber.trim();
}

function profileKey(input: PersonalDeliveryInput): string {
  return input.platform === "telegram"
    ? JSON.stringify({
        platform: input.platform,
        senderId: senderId(input),
        username: input.username?.trim() || null,
        firstName: input.firstName?.trim() || null,
      })
    : input.platform === "discord"
      ? JSON.stringify({
          platform: input.platform,
          senderId: senderId(input),
          username: input.username.trim(),
          globalName:
            input.globalName === undefined
              ? undefined
              : input.globalName?.trim() || null,
          avatarUrl:
            input.avatarUrl === undefined ? undefined : input.avatarUrl,
        })
      : JSON.stringify({
          platform: input.platform,
          senderId: senderId(input),
        });
}

function isPersonalDeliveryResult(
  value: unknown,
): value is PersonalDeliveryResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const target = candidate.dedicatedTarget;
  const validTarget =
    target === null ||
    (typeof target === "object" &&
      boundedText((target as Record<string, unknown>).id) &&
      boundedText((target as Record<string, unknown>).status) &&
      ((target as Record<string, unknown>).bridge_url === null ||
        typeof (target as Record<string, unknown>).bridge_url === "string") &&
      ((target as Record<string, unknown>).agent_config === null ||
        (typeof (target as Record<string, unknown>).agent_config === "object" &&
          !Array.isArray((target as Record<string, unknown>).agent_config))));
  return (
    boundedText(candidate.userId) &&
    boundedText(candidate.organizationId) &&
    validTarget &&
    typeof candidate.isNew === "boolean" &&
    (candidate.resolution === "sender-projection-hit" ||
      candidate.resolution === "single-query-repeat" ||
      candidate.resolution === "exact-dedicated-fallback" ||
      candidate.resolution === "locked-create-or-repair")
  );
}

export async function resolvePersonalDeliveryProjection(
  env: AppEnv["Bindings"],
  input: PersonalDeliveryInput,
  fallback: PersonalDeliveryResolver,
): Promise<PersonalDeliveryResult> {
  const namespace = env.PERSONAL_DELIVERY_PROJECTIONS;
  if (!namespace || env.PERSONAL_DELIVERY_PROJECTION_READ_ENABLED !== "true") {
    return fallback.resolvePersonalDelivery(input);
  }

  let projectionFailure: string;
  try {
    const response = await namespace
      .getByName(
        personalDeliveryProjectionObjectName(input.platform, senderId(input)),
      )
      .fetch(
        `https://personal-delivery-projection${PERSONAL_DELIVERY_PROJECTION_RESOLVE_PATH}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(PROJECTION_RESOLVE_TIMEOUT_MS),
        },
      );
    const body: unknown = await response.json();
    if (response.ok && isPersonalDeliveryResult(body)) return body;
    const upstreamName =
      body !== null &&
      typeof body === "object" &&
      typeof (body as Record<string, unknown>).failureName === "string"
        ? ((body as Record<string, unknown>).failureName as string)
        : undefined;
    projectionFailure = response.ok
      ? "malformed-projection-result"
      : `status-${response.status}${upstreamName ? `:${upstreamName}` : ""}`;
  } catch (error) {
    // error-policy:J4 a projection transport failure (timeout, DO restart,
    // isolate teardown) degrades to the canonical database resolver below; it
    // never fabricates account state and both-path failure still throws.
    projectionFailure = safeProjectionFailureName(error);
  }

  logger.warn(
    "[PersonalDeliveryProjection] projection read degraded to canonical resolver",
    { platform: input.platform, projectionFailure },
  );
  try {
    return await fallback.resolvePersonalDelivery(input);
  } catch (error) {
    // error-policy:J2 both the projection and the canonical resolver failed;
    // rethrow typed with tenant-safe classification and the original cause.
    throw new PersonalDeliveryAccountResolutionError(projectionFailure, error);
  }
}

export class PersonalDeliveryProjection {
  private readonly state: DurableObjectState;
  private readonly env: AppEnv["Bindings"];
  private readonly resolver: PersonalDeliveryResolver | undefined;
  private entry: SharedAccountProjection | undefined;
  private entryLoaded = false;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    state: DurableObjectState,
    env: AppEnv["Bindings"],
    resolver?: PersonalDeliveryResolver,
  ) {
    this.state = state;
    this.env = env;
    this.resolver = resolver;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async loadEntry(): Promise<SharedAccountProjection | undefined> {
    if (!this.entryLoaded) {
      this.entry =
        await this.state.storage.get<SharedAccountProjection>(CACHE_KEY);
      this.entryLoaded = true;
    }
    return this.entry;
  }

  private async invalidate(): Promise<void> {
    await this.state.storage.delete(CACHE_KEY);
    this.entry = undefined;
    this.entryLoaded = true;
  }

  private async resolve(
    input: PersonalDeliveryInput,
  ): Promise<PersonalDeliveryResult> {
    const now = Date.now();
    const expectedProfile = profileKey(input);
    const cached = await this.loadEntry();
    if (
      cached &&
      cached.expiresAt > now &&
      cached.profileKey === expectedProfile
    ) {
      return {
        userId: cached.userId,
        organizationId: cached.organizationId,
        dedicatedTarget: null,
        isNew: false,
        resolution: "sender-projection-hit",
      };
    }
    if (cached) await this.invalidate();

    const resolved = await runWithCloudBindingsAsync(this.env, async () => {
      const resolver =
        this.resolver ??
        (await import("@/lib/services/eliza-app/user-service"))
          .elizaAppUserService;
      return resolver.resolvePersonalDelivery(input);
    });
    if (resolved.dedicatedTarget === null) {
      const projection: SharedAccountProjection = {
        profileKey: expectedProfile,
        userId: resolved.userId,
        organizationId: resolved.organizationId,
        expiresAt: now + CACHE_TTL_MS,
      };
      await this.state.storage.put(CACHE_KEY, projection);
      this.entry = projection;
      this.entryLoaded = true;
    } else {
      await this.invalidate();
    }
    return resolved;
  }

  async fetch(request: Request): Promise<Response> {
    return this.serialize(async () => {
      try {
        const path = new URL(request.url).pathname;
        if (request.method !== "POST") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (path === PERSONAL_DELIVERY_PROJECTION_INVALIDATE_PATH) {
          await this.invalidate();
          return Response.json({ success: true });
        }
        if (path !== PERSONAL_DELIVERY_PROJECTION_RESOLVE_PATH) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        const body: unknown = await request.json();
        if (!isPersonalDeliveryInput(body)) {
          return Response.json(
            { error: "Invalid personal delivery input" },
            { status: 400 },
          );
        }
        return Response.json(await this.resolve(body));
      } catch (error) {
        // error-policy:J1 this internal transport boundary fails closed rather
        // than hiding a projection or database failure behind stale routing.
        logger.error("[PersonalDeliveryProjection] resolution failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          {
            error: "Personal delivery resolution failed",
            failureName: safeProjectionFailureName(error),
          },
          { status: 502 },
        );
      }
    });
  }
}
