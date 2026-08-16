/**
 * Channel-side confirmation of eliza.app identity-link codes (#17344). When an
 * unlinked sender's message carries a `LINK-XXXXXXXX` code, the gateway calls
 * the cloud confirm endpoint with the platform identity it attests; on success
 * it deletes its own `identity:<platform>:<platformId>` negative-cache entry so
 * the very next message from that handle resolves the fresh link instead of
 * re-entering onboarding for the cache TTL (design §"Post-Handoff Routing").
 * Anything that is not clearly a link-code attempt falls through to onboarding.
 */
import {
  extractIdentityLinkCode,
  identityLinkReply,
} from "@elizaos/cloud-services-common/identity-link-code";
import { logger } from "./logger";
import type { GatewayRedis } from "./redis";

const CONFIRM_TIMEOUT_MS = 15_000;

export interface IdentityLinkConfirmDeps {
  redis: Pick<GatewayRedis, "del">;
  cloudBaseUrl: string;
  getAuthHeader: () => { Authorization: string };
  fetchImpl?: typeof fetch;
}

export interface IdentityLinkAttempt {
  /** True when the message was a link-code attempt and a reply was produced. */
  handled: boolean;
  reply?: string;
  linked?: boolean;
}

/** Extracts a link code from message text, or null when there is none. */
export function extractLinkCode(text: string | undefined): string | null {
  return extractIdentityLinkCode(text);
}

/**
 * Confirms a link code for an attested platform identity. Returns handled=false
 * only when the text carries no code at all; a code that fails to confirm is
 * still handled, with a status-specific reply, so onboarding never swallows a
 * failed link attempt as small talk.
 */
export async function tryConfirmIdentityLink(
  deps: IdentityLinkConfirmDeps,
  platform: string,
  platformId: string,
  platformName: string | undefined,
  text: string | undefined,
): Promise<IdentityLinkAttempt> {
  const code = extractLinkCode(text);
  if (!code) return { handled: false };

  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(
    `${deps.cloudBaseUrl}/api/eliza-app/identity-link/confirm`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...deps.getAuthHeader(),
      },
      body: JSON.stringify({ code, platform, platformId, platformName }),
      signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS),
    },
  );

  if (response.ok) {
    // The negative entry must go before the reply: a linked sender whose very
    // next message re-reads the stale notFound entry would be routed back into
    // onboarding until the TTL expires.
    await deps.redis.del(`identity:${platform}:${platformId}`);
    logger.info("Identity link confirmed; negative cache invalidated", {
      platform,
    });
    return {
      handled: true,
      linked: true,
      reply: identityLinkReply("linked"),
    };
  }

  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as {
      data?: { status?: string };
    } | null;
    const status = body?.data?.status ?? "unknown";
    logger.info("Identity link code rejected", { platform, status });
    return { handled: true, linked: false, reply: identityLinkReply(status) };
  }

  // Auth/transport failures are the gateway's problem, not the user's; fail
  // loudly to the caller instead of pretending the code was bad.
  throw new Error(`identity-link confirm failed (${response.status})`);
}
