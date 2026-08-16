/**
 * Per-sender account projection for Personal Shared connector turns.
 *
 * The Durable Object retains only a candidate user lookup hint. Every hit is
 * revalidated against one authoritative database snapshot before any private
 * agent, tenant, room, or Dedicated route is derived. Invalidation remains a
 * performance optimization and is never an authorization boundary.
 */

import { runWithCloudBindingsAsync } from "@/lib/runtime/cloud-bindings";
import {
  PERSONAL_DELIVERY_PROJECTION_INVALIDATE_PATH,
  PERSONAL_DELIVERY_PROJECTION_RESOLVE_PATH,
  personalDeliveryProjectionObjectName,
} from "@/lib/services/eliza-app/personal-delivery-projection-contract";
import type {
  PersonalDeliveryInput,
  PersonalDeliveryProjectionHint,
  PersonalDeliveryResult,
} from "@/lib/services/eliza-app/user-service";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CACHE_KEY = "verified-user-hint:v1";
const LEGACY_CACHE_KEY = "shared-account";
const CACHE_TTL_MS = 60 * 60_000;
const PROJECTION_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SharedAccountProjection {
  version: typeof PROJECTION_VERSION;
  profileKey: string;
  candidateUserId: string;
  expiresAt: number;
}

interface PersonalDeliveryResolver {
  resolvePersonalDelivery(
    params: PersonalDeliveryInput,
  ): Promise<PersonalDeliveryResult>;
}

interface PersonalDeliveryProjectionResolver extends PersonalDeliveryResolver {
  revalidatePersonalDeliveryProjection(
    params: PersonalDeliveryInput,
    expected: PersonalDeliveryProjectionHint,
  ): Promise<PersonalDeliveryResult | null>;
}

function boundedText(value: unknown, max = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function optionalText(value: unknown, max = 512): boolean {
  return (
    value === undefined || (typeof value === "string" && value.length <= max)
  );
}

function isSharedAccountProjection(
  value: unknown,
): value is SharedAccountProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  return (
    keys.length === 4 &&
    keys[0] === "candidateUserId" &&
    keys[1] === "expiresAt" &&
    keys[2] === "profileKey" &&
    keys[3] === "version" &&
    candidate.version === PROJECTION_VERSION &&
    boundedText(candidate.profileKey, 4_096) &&
    typeof candidate.candidateUserId === "string" &&
    UUID_PATTERN.test(candidate.candidateUserId) &&
    typeof candidate.expiresAt === "number" &&
    Number.isSafeInteger(candidate.expiresAt) &&
    candidate.expiresAt > 0
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
  return false;
}

function senderId(input: PersonalDeliveryInput): string {
  return input.platform === "telegram"
    ? input.telegramId.trim()
    : input.discordId.trim();
}

function profileKey(input: PersonalDeliveryInput): string {
  return input.platform === "telegram"
    ? JSON.stringify({
        platform: input.platform,
        senderId: senderId(input),
        username: input.username?.trim() || null,
        firstName: input.firstName?.trim() || null,
      })
    : JSON.stringify({
        platform: input.platform,
        senderId: senderId(input),
        username: input.username.trim(),
        globalName:
          input.globalName === undefined
            ? undefined
            : input.globalName?.trim() || null,
        avatarUrl: input.avatarUrl === undefined ? undefined : input.avatarUrl,
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
      },
    );
  const body: unknown = await response.json();
  if (!response.ok || !isPersonalDeliveryResult(body)) {
    throw new Error(
      `Personal delivery projection failed with status ${response.status}`,
    );
  }
  return body;
}

export class PersonalDeliveryProjection {
  private readonly state: DurableObjectState;
  private readonly env: AppEnv["Bindings"];
  private readonly resolver: PersonalDeliveryProjectionResolver | undefined;
  private entry: SharedAccountProjection | undefined;
  private entryLoaded = false;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(
    state: DurableObjectState,
    env: AppEnv["Bindings"],
    resolver?: PersonalDeliveryProjectionResolver,
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
      const stored = await this.state.storage.get<unknown>(CACHE_KEY);
      this.entryLoaded = true;
      if (stored === undefined)
        await this.state.storage.delete(LEGACY_CACHE_KEY);
      if (stored !== undefined && !isSharedAccountProjection(stored)) {
        await this.state.storage.delete(CACHE_KEY);
        this.entry = undefined;
      } else {
        this.entry = stored;
      }
    }
    return this.entry;
  }

  private async invalidate(): Promise<void> {
    await Promise.all([
      this.state.storage.delete(CACHE_KEY),
      this.state.storage.delete(LEGACY_CACHE_KEY),
    ]);
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
      const verified = await runWithCloudBindingsAsync(this.env, async () => {
        const resolver =
          this.resolver ??
          (await import("@/lib/services/eliza-app/user-service"))
            .elizaAppUserService;
        return resolver.revalidatePersonalDeliveryProjection(input, {
          userId: cached.candidateUserId,
        });
      });
      if (verified && verified.userId === cached.candidateUserId) {
        if (verified.dedicatedTarget) await this.invalidate();
        return verified;
      }
      await this.invalidate();
    }
    if (this.entry) await this.invalidate();

    const resolved = await runWithCloudBindingsAsync(this.env, async () => {
      const resolver =
        this.resolver ??
        (await import("@/lib/services/eliza-app/user-service"))
          .elizaAppUserService;
      return resolver.resolvePersonalDelivery(input);
    });
    if (resolved.dedicatedTarget === null) {
      const projection: SharedAccountProjection = {
        version: PROJECTION_VERSION,
        profileKey: expectedProfile,
        candidateUserId: resolved.userId,
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
        const objectName = this.state.id.name;
        if (
          objectName !==
          personalDeliveryProjectionObjectName(body.platform, senderId(body))
        ) {
          return Response.json(
            { error: "Personal delivery sender does not match object" },
            { status: 409 },
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
          { error: "Personal delivery resolution failed" },
          { status: 502 },
        );
      }
    });
  }
}
