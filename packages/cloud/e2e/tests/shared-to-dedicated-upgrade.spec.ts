/**
 * Shared→dedicated tier upgrade (#15355), end to end against the real router.
 *
 * `app-client-handoff-success.spec.ts` proves the handoff machinery with a
 * hand-inserted dedicated row; this spec drives the PRODUCT flow instead: the
 * user chats on a shared agent, then `POST /upgrade-tier` mints the dedicated
 * migration target with the identity copied SERVER-side and a real provision
 * job, the mock control-plane boots it to running, and the ui-package upgrade
 * handoff module (`runSharedToDedicatedUpgradeHandoff` — the exact code the
 * console's "Upgrade to Dedicated" action runs) moves the conversation and
 * deletes the shared bridge only after the confirmed switch.
 *
 * Asserted, in order:
 *   - the runway credit gate: a balance above the create minimum but below
 *     3 days of hosting is refused with the canonical 402 carrying the
 *     ENFORCED threshold, and mints nothing,
 *   - another org's key cannot upgrade the agent (404, no cross-org oracle),
 *   - the funded upgrade copies agent_name/agent_config server-side onto a
 *     dedicated-always row and enqueues a real provision job,
 *   - an immediate retry reattaches to the SAME in-flight target (no second
 *     container),
 *   - chat continuity: every shared turn lands on the dedicated agent in
 *     order with the conversation id preserved,
 *   - the shared bridge is deleted ONLY after the confirmed switch, and the
 *     deleted id then reads as 404 for further upgrades.
 */

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { ElizaClient } from "@elizaos/ui/api";
import { getBootConfig, setBootConfig } from "@elizaos/ui/config";
// Playwright spec marker: `test`/`expect` arrive via the shared fixtures
// below, but the coverage gate classifies a changed *.spec.ts by grepping for
// a DIRECT @playwright/test import — without one it would run this file under
// `bun test`. Type-only and empty, so it costs nothing at runtime.
import type {} from "@playwright/test";
// Relative source import (Playwright transpiles the two-file TS graph): the
// `./cloud/*` subpath of @elizaos/ui resolves to dist, which is built from the
// primary checkout and may not carry this module yet. `ElizaClient` above still
// comes from the package build — the module takes it as an injected client.
import { runSharedToDedicatedUpgradeHandoff } from "../../../ui/src/cloud/handoff/start-tier-upgrade";
import { authedClient } from "../src/helpers/monetization";
import { pollSandboxStatus } from "../src/helpers/provisioning";
import { seedModelPricing } from "../src/helpers/seed-pricing";
import { expect, test } from "../src/helpers/test-fixtures";

// Context-echo mock LLM: the shared turns must produce a REAL transcript or
// there is nothing whose continuity can be asserted. API-only (no browser).
test.use({ stackOptions: { frontend: false, mockLlmEchoContext: true } });

const MODEL = "openai/gpt-4o-mini";

async function setOrgBalance(orgId: string, balance: string): Promise<void> {
  const { organizationsRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/organizations"
  );
  await organizationsRepository.update(orgId, { credit_balance: balance });
}

test.describe("shared→dedicated tier upgrade", () => {
  test("gates on hosting runway, copies identity server-side, and moves the conversation", async ({
    stack,
    seededUser,
  }) => {
    test.setTimeout(180_000);
    const cloudApiBase = stack.urls.api;
    const authToken = seededUser.apiKey;
    const api = { apiUrl: cloudApiBase };
    const c = authedClient(cloudApiBase, authToken);

    const prevBoot = getBootConfig();
    const prevToken = readStoredStewardToken();
    setBootConfig({ ...prevBoot, cloudApiBase });
    writeStoredStewardToken(authToken);

    // Price the shared turn's model so the in-Worker billing path can settle a
    // real debit (no live provider key) — without it the shared turn 500s
    // before any transcript exists to migrate.
    await seedModelPricing({
      model: MODEL,
      billingSource: "bitrouter",
      provider: "openai",
    });

    try {
      // ── 1. The shared agent the user chats on. ─────────────────────────
      const sharedCreate = await c<{
        data?: { id?: string; agentId?: string; executionTier?: string };
      }>("POST", "/api/v1/eliza/agents", {
        agentName: `Upgrade Front ${Date.now().toString(36)}`,
        agentConfig: {
          character: {
            name: "Front",
            system: "You are the instant shared front agent.",
            model: MODEL,
          },
        },
      });
      expect([200, 201]).toContain(sharedCreate.status);
      const sharedAgentId =
        sharedCreate.json.data?.id ?? sharedCreate.json.data?.agentId;
      expect(sharedAgentId, "shared agent has an id").toBeTruthy();
      if (!sharedAgentId) throw new Error("no shared agent id");
      expect(sharedCreate.json.data?.executionTier).toBe("shared");

      // ── 2. A real conversation on the shared agent. ────────────────────
      const convoUrl = `/api/v1/eliza/agents/${sharedAgentId}/api/conversations/${sharedAgentId}/messages`;
      const FIRST = "Remember: my project is codenamed Aurora.";
      const SECOND = "What is my project codenamed?";
      expect((await c("POST", convoUrl, { text: FIRST })).status).toBe(200);
      expect((await c("POST", convoUrl, { text: SECOND })).status).toBe(200);
      const sharedHistory = await c<{
        messages?: Array<{ role: string; text: string }>;
      }>("GET", convoUrl);
      expect(
        sharedHistory.json.messages?.length,
        "shared transcript has both turns (user+assistant ×2)",
      ).toBe(4);

      // ── 3. Runway credit gate: refused BELOW 3 days of hosting. ────────
      // $0.50 clears the $0.10 create minimum — the gate the create/provision
      // routes use — so this proves upgrade-tier enforces the STRICTER runway.
      await setOrgBalance(seededUser.organizationId, "0.50");
      const gated = await c<{
        code?: string;
        requiredBalance?: number;
        currentBalance?: number;
        error?: string;
      }>("POST", `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`);
      expect(gated.status, "runway gate refuses with 402").toBe(402);
      expect(gated.json.code).toBe("insufficient_credits");
      expect(
        gated.json.requiredBalance,
        "402 carries the enforced runway threshold (3 × $0.24/day)",
      ).toBe(0.72);
      expect(gated.json.currentBalance).toBe(0.5);
      expect(gated.json.error).toContain("3 days of hosting");

      // ── 4. Cross-org denial: another org's key reads the agent as 404. ──
      const { seedTestUser } = await import("../src/fixtures/seed");
      const attacker = await seedTestUser({ slug: `attacker-${Date.now()}` });
      const attackerCall = authedClient(cloudApiBase, attacker.apiKey);
      const foreign = await attackerCall<{ error?: string }>(
        "POST",
        `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`,
      );
      expect(foreign.status, "cross-org upgrade probe is a 404").toBe(404);
      expect(foreign.json.error).toBe("Agent not found");

      // ── 5. Funded upgrade: identity copied server-side + provision job. ──
      await setOrgBalance(seededUser.organizationId, "1000.000000");
      const started = await c<{
        success?: boolean;
        created?: boolean;
        data?: {
          dedicatedAgentId?: string;
          sharedAgentId?: string;
          jobId?: string;
          executionTier?: string;
        };
        polling?: { endpoint?: string };
      }>("POST", `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`);
      expect(started.status, "funded upgrade is accepted").toBe(202);
      expect(started.json.created).toBe(true);
      const dedicatedAgentId = started.json.data?.dedicatedAgentId;
      expect(
        dedicatedAgentId,
        "upgrade minted a dedicated target",
      ).toBeTruthy();
      if (!dedicatedAgentId) throw new Error("no dedicated agent id");
      expect(dedicatedAgentId).not.toBe(sharedAgentId);
      expect(started.json.data?.sharedAgentId).toBe(sharedAgentId);
      expect(started.json.data?.executionTier).toBe("dedicated-always");
      expect(
        started.json.data?.jobId,
        "a real provision job exists",
      ).toBeTruthy();

      const { agentSandboxesRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
      );
      const sharedRow = await agentSandboxesRepository.findByIdAndOrg(
        sharedAgentId,
        seededUser.organizationId,
      );
      const dedicatedRow = await agentSandboxesRepository.findByIdAndOrg(
        dedicatedAgentId,
        seededUser.organizationId,
      );
      expect(dedicatedRow, "dedicated row is org-owned").toBeTruthy();
      expect(dedicatedRow?.execution_tier).toBe("dedicated-always");
      expect(sharedRow?.agent_name, "shared source still exists").toBeTruthy();
      expect(dedicatedRow?.agent_name, "agent name copied server-side").toBe(
        sharedRow?.agent_name ?? "",
      );
      const dedicatedConfig = dedicatedRow?.agent_config as Record<
        string,
        unknown
      > | null;
      expect(
        (dedicatedConfig?.character as { system?: string } | undefined)?.system,
        "character config copied server-side",
      ).toBe("You are the instant shared front agent.");
      expect(
        dedicatedConfig?.__agentUpgradedFrom,
        "server-side reattach marker recorded",
      ).toBe(sharedAgentId);

      // ── 6. Retry reattaches — never a second container. ────────────────
      const retried = await c<{
        created?: boolean;
        alreadyInProgress?: boolean;
        data?: { dedicatedAgentId?: string };
      }>("POST", `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`);
      expect([200, 202]).toContain(retried.status);
      expect(retried.json.created).toBe(false);
      expect(retried.json.alreadyInProgress).toBe(true);
      expect(retried.json.data?.dedicatedAgentId).toBe(dedicatedAgentId);

      // ── 7. Boot the dedicated target through the mock control-plane. ────
      await pollSandboxStatus(api, authToken, dedicatedAgentId, "running", {
        timeoutMs: 60_000,
        intervalMs: 250,
        onTick: async () => {
          const result = await stack.mocks.controlPlane.processDbBackedJobs(
            stack.urls.pglite,
          );
          expect(result.failed, JSON.stringify(result.errors)).toBe(0);
        },
      });

      // ── 8. Chat continuity: the console's handoff module, for real. ─────
      let switchedBase: string | null = null;
      const outcome = await runSharedToDedicatedUpgradeHandoff({
        sharedAgentId,
        dedicatedAgentId,
        cloudApiBase,
        authToken,
        client: new ElizaClient(cloudApiBase, authToken),
        intervalMs: 250,
        timeoutMs: 30_000,
        onSwitch: (base) => {
          switchedBase = base;
        },
        log: (m) => console.log(`[upgrade-handoff] ${m}`),
      });

      expect(
        outcome.status,
        `the upgrade SWITCHED (did not time out): ${outcome.error ?? ""}`,
      ).toBe("switched");
      expect(
        outcome.imported,
        "every shared turn was imported into the dedicated agent",
      ).toBe(4);
      expect(switchedBase, "switched onto the dedicated base").toBeTruthy();
      expect(switchedBase).not.toContain(
        `/api/v1/eliza/agents/${sharedAgentId}`,
      );

      const dedicatedTranscript =
        stack.mocks.controlPlane.store.getConversationByAgent(
          dedicatedAgentId,
          sharedAgentId,
        );
      expect(
        dedicatedTranscript.map((m) => m.role),
        "imported transcript preserves user/assistant ordering",
      ).toEqual(["user", "assistant", "user", "assistant"]);
      expect(dedicatedTranscript[0]?.text).toBe(FIRST);
      expect(dedicatedTranscript[2]?.text).toBe(SECOND);

      // ── 9. The shared bridge is gone ONLY now (post-switch), for real. ──
      expect(
        outcome.sharedBridgeDeleted,
        "shared bridge deleted after the confirmed switch",
      ).toBe(true);
      const sharedAfter = await agentSandboxesRepository.findByIdAndOrg(
        sharedAgentId,
        seededUser.organizationId,
      );
      expect(sharedAfter, "shared agent row removed").toBeFalsy();
      const upgradeDeleted = await c<{ error?: string }>(
        "POST",
        `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`,
      );
      expect(upgradeDeleted.status, "deleted shared id reads as 404").toBe(404);
    } finally {
      setBootConfig(prevBoot);
      if (prevToken === null) {
        clearStoredStewardToken();
      } else {
        writeStoredStewardToken(prevToken);
      }
    }
  });
});
