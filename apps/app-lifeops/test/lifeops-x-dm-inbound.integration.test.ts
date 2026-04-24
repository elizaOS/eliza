/**
 * Integration test: X DM inbound read via `readXInboundDms()` and `syncXDms()`.
 *
 * Gated on `TWITTER_API_KEY` being set. When credentials are absent the suite
 * skips cleanly via `itIf`. Set `SKIP_REASON` to document a deliberate skip.
 *
 * When credentials are present, a live call to the Twitter API v2 `/dm_events`
 * endpoint is made and the result is persisted in the local PGlite store.
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";
import { createLifeOpsConnectorGrant } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

const SKIP_REASON = process.env.SKIP_REASON?.trim();
const HAS_X_CREDENTIALS = Boolean(
  process.env.TWITTER_API_KEY?.trim() &&
    process.env.TWITTER_API_SECRET?.trim() &&
    process.env.TWITTER_ACCESS_TOKEN?.trim() &&
    process.env.TWITTER_ACCESS_TOKEN_SECRET?.trim(),
);
const LIVE_CREDS_AVAILABLE = !SKIP_REASON && HAS_X_CREDENTIALS;

describe("Integration: X DM inbound", () => {
  let oauthDir: string;
  let prevOAuthDir: string | undefined;
  let prevStateDir: string | undefined;
  let prevDisableProactive: string | undefined;
  let runtime: Awaited<ReturnType<typeof createLifeOpsTestRuntime>> | undefined;

  beforeEach(async () => {
    oauthDir = await mkdtemp(path.join(os.tmpdir(), "lifeops-x-dm-inbound-"));
    prevOAuthDir = process.env.ELIZA_OAUTH_DIR;
    prevStateDir = process.env.ELIZA_STATE_DIR;
    prevDisableProactive = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    process.env.ELIZA_OAUTH_DIR = oauthDir;
    process.env.ELIZA_STATE_DIR = path.join(oauthDir, "state");
    await mkdir(process.env.ELIZA_STATE_DIR, { recursive: true });
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
  });

  afterEach(async () => {
    if (runtime) { await runtime.cleanup(); runtime = undefined; }
    if (prevOAuthDir === undefined) delete process.env.ELIZA_OAUTH_DIR;
    else process.env.ELIZA_OAUTH_DIR = prevOAuthDir;
    if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = prevStateDir;
    if (prevDisableProactive === undefined) delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    else process.env.ELIZA_DISABLE_PROACTIVE_AGENT = prevDisableProactive;
    await rm(oauthDir, { recursive: true, force: true });
  });

  it("connector status reports dmInbound: false when x.dm.read is not granted", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);
    const status = await service.getXConnectorStatus();
    expect(status.dmInbound).toBe(false);
  });

  it("connector status reports dmInbound: true when x.dm.read is granted", async () => {
    // The local X connector gates capabilities on both the stored grant and
    // locally-available credentials (poster creds + TWITTER_USER_ID). Stub
    // them here so the test exercises the pure grant path.
    const prevTwitterEnv = {
      TWITTER_API_KEY: process.env.TWITTER_API_KEY,
      TWITTER_API_SECRET: process.env.TWITTER_API_SECRET,
      TWITTER_ACCESS_TOKEN: process.env.TWITTER_ACCESS_TOKEN,
      TWITTER_ACCESS_TOKEN_SECRET: process.env.TWITTER_ACCESS_TOKEN_SECRET,
      TWITTER_USER_ID: process.env.TWITTER_USER_ID,
    };
    process.env.TWITTER_API_KEY = prevTwitterEnv.TWITTER_API_KEY ?? "stub-key";
    process.env.TWITTER_API_SECRET =
      prevTwitterEnv.TWITTER_API_SECRET ?? "stub-secret";
    process.env.TWITTER_ACCESS_TOKEN =
      prevTwitterEnv.TWITTER_ACCESS_TOKEN ?? "stub-access-token";
    process.env.TWITTER_ACCESS_TOKEN_SECRET =
      prevTwitterEnv.TWITTER_ACCESS_TOKEN_SECRET ?? "stub-access-secret";
    process.env.TWITTER_USER_ID =
      prevTwitterEnv.TWITTER_USER_ID ?? "stub-user-id";
    try {
      runtime = await createLifeOpsTestRuntime();
      const service = new LifeOpsService(runtime.runtime);
      await service.repository.upsertConnectorGrant(
        createLifeOpsConnectorGrant({
          agentId: runtime.runtime.agentId,
          provider: "x",
          identity: {},
          grantedScopes: [],
          capabilities: ["x.read", "x.dm.read"],
          tokenRef: null,
          mode: "local",
          metadata: {},
          lastRefreshAt: new Date().toISOString(),
        }),
      );
      const status = await service.getXConnectorStatus();
      expect(status.dmInbound).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(prevTwitterEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("getXDms returns empty array before any sync", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);
    const dms = await service.getXDms();
    expect(dms).toEqual([]);
  });

  itIf(LIVE_CREDS_AVAILABLE)(
    "syncXDms fetches and persists DMs from the X API",
    async () => {
      runtime = await createLifeOpsTestRuntime();
      const service = new LifeOpsService(runtime.runtime);

      // Register the grant so syncXDms does not reject with 409.
      await service.repository.upsertConnectorGrant(
        createLifeOpsConnectorGrant({
          agentId: runtime.runtime.agentId,
          provider: "x",
          identity: {},
          grantedScopes: [],
          capabilities: ["x.read", "x.write", "x.dm.read"],
          tokenRef: null,
          mode: "local",
          metadata: {},
          lastRefreshAt: new Date().toISOString(),
        }),
      );

      const syncResult = await service.syncXDms({ limit: 10 });
      // synced may be 0 if the account has no DMs; what matters is no throw.
      expect(typeof syncResult.synced).toBe("number");
      expect(syncResult.synced).toBeGreaterThanOrEqual(0);

      const allDms = await service.getXDms({ limit: 10 });
      expect(allDms.length).toBe(syncResult.synced);
      for (const dm of allDms) {
        expect(typeof dm.externalDmId).toBe("string");
        expect(typeof dm.text).toBe("string");
        expect(typeof dm.isInbound).toBe("boolean");
      }
    },
    30_000,
  );

  itIf(LIVE_CREDS_AVAILABLE)(
    "readXInboundDms returns only inbound messages",
    async () => {
      runtime = await createLifeOpsTestRuntime();
      const service = new LifeOpsService(runtime.runtime);

      await service.repository.upsertConnectorGrant(
        createLifeOpsConnectorGrant({
          agentId: runtime.runtime.agentId,
          provider: "x",
          identity: {},
          grantedScopes: [],
          capabilities: ["x.read", "x.write", "x.dm.read"],
          tokenRef: null,
          mode: "local",
          metadata: {},
          lastRefreshAt: new Date().toISOString(),
        }),
      );

      const inbound = await service.readXInboundDms({ limit: 10 });
      // All returned items must have isInbound: true.
      for (const dm of inbound) {
        expect(dm.isInbound).toBe(true);
      }
    },
    30_000,
  );
});
