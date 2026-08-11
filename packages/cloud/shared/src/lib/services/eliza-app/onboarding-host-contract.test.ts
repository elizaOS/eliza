/**
 * Deployment contract for the two onboarding frontend origins: `/get-started`
 * belongs to the homepage, dashboard and billing links belong to the Cloud app.
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
 * `loginOrigin` is the homepage. Staging has no homepage deployment of its own,
 * so it still resolves the production one — a live release blocker recorded in
 * #18197, not an approved mapping. The expectation below documents the defect so
 * it cannot drift silently; closing #18197 must change it.
 */
const ONBOARDING_HOST_CONTRACT: ReadonlyArray<{
  section: string;
  loginOrigin: string;
  appOrigin: string;
}> = [
  {
    section: "vars",
    loginOrigin: "https://eliza.app",
    appOrigin: "https://app.elizacloud.ai",
  },
  {
    section: "env.production.vars",
    loginOrigin: "https://eliza.app",
    appOrigin: "https://app.elizacloud.ai",
  },
  {
    section: "env.staging.vars",
    loginOrigin: "https://eliza.app",
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
    "$section keeps the login origin off the dashboard origin",
    async ({ section }) => {
      const resolved = await resolveOnboardingOrigins(section);
      expect(resolved.loginOrigin).not.toBe(resolved.appOrigin);
    },
  );

  test("staging never resolves a production dashboard origin", async () => {
    const resolved = await resolveOnboardingOrigins("env.staging.vars");
    expect(PRODUCTION_APP_ORIGINS).not.toContain(resolved.appOrigin);
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
