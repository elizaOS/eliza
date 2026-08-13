/**
 * Deployment contract for the onboarding frontend origins. The messaging
 * continuation Connect CTA (`/get-started`) and the dashboard/billing links now
 * both live on the Cloud app: the CTA opens the app's authenticated
 * `/get-started`, which sends signed-out users straight into Steward login and
 * hands back to Discord, so there is no intermediate homepage sign-in card.
 *
 * The contract is checked through effective resolution, not string presence.
 * Each case parses one deployed environment's complete `[vars]` block out of the
 * Worker config, installs it as the cloud bindings context exactly as the
 * request pipeline does, and asserts the URLs the onboarding state machine
 * actually emits. A wrong host therefore fails here even when the key is
 * present, and an origin that resolves correctly through a fallback is not
 * reported as a gap. Real resolver, real config, in-memory session store.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";
import {
  type OnboardingSession,
  type OnboardingSessionStore,
  runOnboardingChatWithStore,
} from "./onboarding-chat";

const WRANGLER_PATH = join(import.meta.dir, "../../../../../api/wrangler.toml");

function tomlSection(source: string, name: string): string {
  const header = `[${name}]`;
  const headerIndex = source.indexOf(header);
  if (headerIndex < 0) throw new Error(`Missing TOML section ${header}`);

  const body = source.slice(headerIndex + header.length);
  const nextSectionIndex = body.search(/^\[/m);
  return nextSectionIndex < 0 ? body : body.slice(0, nextSectionIndex);
}

/**
 * The string vars of one section, shaped like the `c.env` bindings a deployed
 * Worker receives. Cloudflare does not inherit top-level `[vars]` into a named
 * environment, so a section is read alone — never merged with `[vars]`.
 */
function environmentBindings(section: string): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const line of tomlSection(readFileSync(WRANGLER_PATH, "utf8"), section).split("\n")) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match) bindings[match[1]] = match[2];
  }
  if (Object.keys(bindings).length === 0) {
    throw new Error(`TOML section [${section}] parsed to zero string vars`);
  }
  return bindings;
}

function memoryStore(): OnboardingSessionStore {
  const sessions = new Map<string, OnboardingSession>();
  return {
    async load(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    async save(session) {
      sessions.set(session.id, session);
    },
  };
}

/**
 * One onboarding turn under a deployed environment's bindings. A trusted phone
 * identity that supplies a name reaches the login handoff without an
 * authenticated user, so the turn resolves both origins and never touches
 * provisioning, the database, or the account store.
 */
async function resolveOnboardingOrigins(
  section: string,
): Promise<{ loginOrigin: string; appOrigin: string }> {
  const sessionId = "platform:blooio:+14155550123";
  const result = await runWithCloudBindingsAsync(environmentBindings(section), () =>
    runOnboardingChatWithStore(
      {
        message: "call me Sam",
        platform: "blooio",
        platformUserId: "+14155550123",
        trustedPlatformIdentity: true,
      },
      sessionId,
      memoryStore(),
    ),
  );

  expect(result.requiresLogin).toBe(true);
  return {
    loginOrigin: new URL(result.loginUrl).origin,
    appOrigin: new URL(result.controlPanelUrl).origin,
  };
}

/**
 * `appOrigin` is the Eliza *app* host, never the console apex: production pins
 * app.elizacloud.ai while its NEXT_PUBLIC_APP_URL is the apex elizacloud.ai, and
 * staging's peer of that app host is app-staging.elizacloud.ai (the `eliza-app`
 * Pages domain, same environment-peer rule as STAGING_ELIZA_APP_ORIGIN in
 * packages/ui/src/utils/cloud-agent-base.ts).
 *
 * `loginOrigin` is the messaging-continuation Connect CTA target. It now equals
 * the Cloud *app* host: the CTA points at the app's authenticated
 * `/get-started`, which bounces signed-out users straight to Steward login
 * (`/login?returnTo=/get-started`) and hands back to Discord — no intermediate
 * homepage sign-in card. Both origins therefore resolve to the same app host,
 * per environment, and staging must resolve its own app peer so a staging token
 * is redeemed against the staging endpoint.
 */
const ONBOARDING_HOST_CONTRACT: ReadonlyArray<{
  section: string;
  loginOrigin: string;
  appOrigin: string;
}> = [
  {
    section: "vars",
    loginOrigin: "https://app.elizacloud.ai",
    appOrigin: "https://app.elizacloud.ai",
  },
  {
    section: "env.production.vars",
    loginOrigin: "https://app.elizacloud.ai",
    appOrigin: "https://app.elizacloud.ai",
  },
  {
    section: "env.staging.vars",
    loginOrigin: "https://app-staging.elizacloud.ai",
    appOrigin: "https://app-staging.elizacloud.ai",
  },
];

const PRODUCTION_APP_ORIGINS = ["https://app.elizacloud.ai", "https://elizacloud.ai"];

describe("onboarding host deployment contract", () => {
  test.each(ONBOARDING_HOST_CONTRACT)(
    "$section resolves the onboarding origins its bindings deploy",
    async ({ section, loginOrigin, appOrigin }) => {
      const resolved = await resolveOnboardingOrigins(section);
      expect(resolved.appOrigin).toBe(appOrigin);
      expect(resolved.loginOrigin).toBe(loginOrigin);
    },
  );

  test.each(ONBOARDING_HOST_CONTRACT)(
    "$section routes the continuation Connect CTA into the Cloud app /get-started, not the homepage",
    async ({ section, appOrigin }) => {
      const resolved = await resolveOnboardingOrigins(section);
      // The Steward-login handoff lives on the Cloud app, so login and app
      // origins coincide by design; neither is the homepage (eliza.app).
      expect(resolved.loginOrigin).toBe(appOrigin);
      expect(resolved.loginOrigin).not.toBe("https://eliza.app");
      expect(resolved.loginOrigin).not.toBe("https://staging.eliza.app");
    },
  );

  test("staging never resolves a production dashboard origin", async () => {
    const resolved = await resolveOnboardingOrigins("env.staging.vars");
    expect(PRODUCTION_APP_ORIGINS).not.toContain(resolved.appOrigin);
  });

  test("staging never resolves a production login origin for the continuation CTA", async () => {
    const resolved = await resolveOnboardingOrigins("env.staging.vars");
    expect(PRODUCTION_APP_ORIGINS).not.toContain(resolved.loginOrigin);
  });

  test("the staging section pins the app origin instead of inheriting one", () => {
    const staging = environmentBindings("env.staging.vars");
    // Resolution alone cannot tell a pin from a fallback: NEXT_PUBLIC_APP_URL
    // would answer for ELIZA_ONBOARDING_APP_URL and quietly hand back the
    // console apex the moment the explicit key is dropped.
    expect(staging.ELIZA_ONBOARDING_APP_URL).toBe("https://app-staging.elizacloud.ai");
    expect(staging.NEXT_PUBLIC_APP_URL).toBe("https://staging.elizacloud.ai");
  });
});
