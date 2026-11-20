import type { StagingSessionBindingEnv } from "./staging-session-binding";
import type { StewardTokenClaims } from "./steward-client";

export const STAGING_SESSION_FIXTURE_TENANT_ID = "elizacloud-staging";

export function isRealStewardUserId(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length > 0 &&
    ![
      "system:",
      "anonymous:",
      "affiliate:",
      "wallet:",
      "email:",
      "telegram:",
      "discord:",
      "phone:",
      "whatsapp:",
      "svc_",
    ].some((prefix) => normalized.startsWith(prefix))
  );
}

export function isConfiguredStagingSessionFixtureEmail(
  env: StagingSessionBindingEnv,
  email: string | undefined,
): boolean {
  const fixtureEmail = env.STAGING_SESSION_EXCHANGE_FIXTURE_EMAIL?.trim().toLowerCase();
  return (
    env.NODE_ENV === "production" &&
    env.ENVIRONMENT === "staging" &&
    Boolean(fixtureEmail) &&
    email?.trim().toLowerCase() === fixtureEmail
  );
}

/** Select the fixture organization only during a verified ordinary signup. */
export function classifyStagingSessionFixtureSignup(
  env: StagingSessionBindingEnv,
  input: { email?: string; stewardUserId: string; verifiedSession?: StewardTokenClaims },
): "ordinary" | "fixture" | "unverified" {
  if (!isConfiguredStagingSessionFixtureEmail(env, input.email)) return "ordinary";
  const session = input.verifiedSession;
  return env.STEWARD_TENANT_ID === STAGING_SESSION_FIXTURE_TENANT_ID &&
    session?.tenantId === STAGING_SESSION_FIXTURE_TENANT_ID &&
    session.email?.trim().toLowerCase() === input.email?.trim().toLowerCase() &&
    session.userId === input.stewardUserId &&
    isRealStewardUserId(session.userId) &&
    session.authMethod === "email" &&
    !session.bridged &&
    !session.stagingSessionBinding
    ? "fixture"
    : "unverified";
}
