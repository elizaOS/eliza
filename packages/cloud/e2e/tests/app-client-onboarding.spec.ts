/**
 * App onboarding client ↔ real cloud-api router.
 *
 * Every other cloud test drives the cloud-api with raw fetch (the router side)
 * or mocks the cloud client (the app side). This spec closes the seam between
 * them: it runs the *real* app client — `@elizaos/ui`'s `ElizaClient` cloud
 * methods that the first-run onboarding controller actually calls — against the
 * *real* cloud-api router (mock sandbox provider). It proves the on-the-wire
 * contract the Mac/iOS app depends on for the cloud-hosted + cloud-inference
 * onboarding modes, without a browser, a dev server, or any real credentials.
 *
 * Covered:
 *   1. New user → `selectOrProvisionCloudAgent({ forceCreate })` creates a cloud
 *      agent through the router and returns a usable per-agent apiBase.
 *   2. Returning user → `selectOrProvisionCloudAgent()` (no force) REUSES that
 *      agent instead of creating another (the "don't spawn an agent on every
 *      sign-in" guarantee), driven off the router's real list endpoint.
 *   3. `startCloudAgentHandoff` runs against the router and degrades gracefully
 *      when no personal container is reachable (memory provider) — it resolves
 *      without throwing and without switching, i.e. the user safely stays on the
 *      shared adapter. This is the documented best-effort handoff contract.
 */

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { ElizaClient } from "@elizaos/ui/api";
import { DIRECT_ELIZA_CLOUD_API_BY_HOST } from "@elizaos/ui/api/direct-cloud-endpoints";
import { getBootConfig, setBootConfig } from "@elizaos/ui/config";
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("app onboarding client ↔ real cloud-api", () => {
  test("real ElizaClient provisions, reuses, and arms the handoff through the router", async ({
    stack,
    seededUser,
  }) => {
    const cloudApiBase = stack.urls.api;
    const authToken = seededUser.apiKey;

    // Make the app client treat the mock cloud-api as a canonical direct-cloud
    // base. Direct routing is host-allowlisted; the compat fetch reads the cloud
    // token from the global the controller normally sets at sign-in.
    const prevBoot = getBootConfig();
    const prevToken = readStoredStewardToken();
    const cloudApiHost = new URL(cloudApiBase).hostname.toLowerCase();
    const prevDirectCloudApiBase =
      DIRECT_ELIZA_CLOUD_API_BY_HOST.get(cloudApiHost);
    // Production only treats canonical Eliza Cloud hosts as direct control
    // planes. This local stack is intentionally equivalent, so register its
    // ephemeral host for the duration of the test instead of letting the real
    // client fall through to the agent-proxy `/api/cloud/compat/*` route.
    try {
      DIRECT_ELIZA_CLOUD_API_BY_HOST.set(cloudApiHost, cloudApiBase);
      setBootConfig({ ...prevBoot, cloudApiBase });
      await writeStoredStewardToken(authToken);

      const client = new ElizaClient(cloudApiBase, authToken);

      // 1) New user with no agents → provision a fresh cloud agent.
      // SHARED tier: this spec covers the container-free onboarding the app
      // uses to put a user in chat immediately. A shared agent is born
      // `running`, is reached through the shared REST adapter under
      // /api/v1/eliza/agents/<id>, and never gets a dedicated container — which
      // is exactly the world step 3 asserts against. Without `preferSharedTier`
      // the client provisions a DEDICATED agent instead and blocks in
      // `waitForCloudAgentRunning` for a container this harness only advances
      // when a test pumps the control-plane job queue, so the call never
      // returns.
      // No `forceCreate`: the router rejects it for the shared tier ("a shared
      // agent never needs to bypass the reuse guard"), and this user genuinely
      // has no agents — the reuse lookup finds none and falls through to the
      // create, which is the real first-run path.
      const progress: string[] = [];
      const created = await client.selectOrProvisionCloudAgent({
        cloudApiBase,
        authToken,
        name: "E2E Cloud Agent",
        bio: ["An end-to-end cloud onboarding agent."],
        preferSharedTier: true,
        onProgress: (status) => progress.push(status),
      });

      expect(created.created).toBe(true);
      expect(created.agentId).toBeTruthy();
      expect(created.executionTier, "onboarded onto the shared tier").toBe(
        "shared",
      );
      // Always a per-agent base (never the agent-id-less collection URL).
      expect(created.apiBase).toContain(created.agentId);
      expect(progress).toContain("ready");

      // 2) Returning user (no forceCreate) → reuse the same agent, do not create
      //    another. Driven off the router's real list endpoint. The reuse
      //    lookup FILTERS OUT shared agents unless the caller asks for that
      //    tier, so a shared-tier sign-in must carry the same preference or the
      //    client would mint a second agent instead of reusing this one.
      const reused = await client.selectOrProvisionCloudAgent({
        cloudApiBase,
        authToken,
        name: "E2E Cloud Agent",
        preferSharedTier: true,
      });

      expect(reused.created).toBe(false);
      expect(reused.agentId).toBe(created.agentId);

      // 3) Handoff orchestrator runs against the router. With no reachable
      //    personal container (memory sandbox provider), it must resolve
      //    gracefully — never throw, never switch — leaving the user on the
      //    working shared adapter.
      let switched = false;
      const handoff = await client.startCloudAgentHandoff({
        agentId: created.agentId,
        sharedApiBase: created.apiBase,
        conversationId: created.agentId,
        cloudApiBase,
        authToken,
        onSwitch: () => {
          switched = true;
        },
        intervalMs: 200,
        timeoutMs: 1_500,
      });

      expect(["timed-out", "switched", "switched-empty", "failed"]).toContain(
        handoff.status,
      );
      // No personal container is reachable, so the user must not be switched off
      // the shared adapter.
      expect(switched).toBe(false);
      expect(handoff.status).toBe("timed-out");
    } finally {
      if (prevDirectCloudApiBase === undefined) {
        DIRECT_ELIZA_CLOUD_API_BY_HOST.delete(cloudApiHost);
      } else {
        DIRECT_ELIZA_CLOUD_API_BY_HOST.set(
          cloudApiHost,
          prevDirectCloudApiBase,
        );
      }
      setBootConfig(prevBoot);
      if (prevToken === null) {
        await clearStoredStewardToken();
      } else {
        await writeStoredStewardToken(prevToken);
      }
    }
  });
});
