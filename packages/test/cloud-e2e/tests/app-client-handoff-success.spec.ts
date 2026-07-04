/**
 * App onboarding handoff — the SUCCESS switch, end to end.
 *
 * `app-client-onboarding.spec.ts` covers the NEGATIVE handoff contract: with no
 * reachable dedicated container the orchestrator degrades gracefully (times out,
 * never switches, user stays on the shared adapter). This spec closes the other
 * half — the case the whole seamless-provision feature exists for: a real
 * shared→dedicated SWITCH, with the transcript the user built on the shared
 * agent copied into their freshly provisioned dedicated container.
 *
 * It runs the *real* `ElizaClient.startCloudAgentHandoff` against the *real*
 * cloud-api router, with the dedicated agent provisioned-to-running through the
 * mock control-plane (so it advertises a reachable base), and a real transcript
 * seeded on the shared agent via the context-echo mock LLM. The previously
 * missing fixtures (the dedicated agent's `/api/conversations/:id/import` +
 * `/messages` routes, the conversation store) now live on the control-plane mock.
 *
 * Asserted:
 *   - the handoff reaches `switched` (NOT `timed-out`),
 *   - `onSwitch` fired with the dedicated container base (not the shared adapter),
 *   - every shared turn was imported into the dedicated agent (`imported > 0`),
 *   - the conversation id is stable across the switch,
 *   - the dedicated agent's stored transcript matches what the user had, and
 *   - re-running the handoff is idempotent (no duplicate import — `switched`
 *     again, nothing re-inserted).
 */

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { ElizaClient } from "@elizaos/ui/api";
import { getBootConfig, setBootConfig } from "@elizaos/ui/config";
import { authedClient } from "../src/helpers/monetization";
import {
  pollSandboxStatus,
  startAgentProvisioning,
} from "../src/helpers/provisioning";
import { seedModelPricing } from "../src/helpers/seed-pricing";
import { expect, test } from "../src/helpers/test-fixtures";

// Context-echo mock LLM so the shared turns produce a deterministic, real
// transcript (reply derived from replayed history) — there must be something to
// copy, otherwise the handoff only ever reaches `switched-empty`. API-only: no
// browser is driven here, we exercise the client methods directly.
test.use({ stackOptions: { frontend: false, mockLlmEchoContext: true } });

const MODEL = "openai/gpt-4o-mini";

test.describe("app onboarding handoff — success switch", () => {
  test("provisions a dedicated agent, copies the shared transcript, and switches the client onto it", async ({
    stack,
    seededUser,
  }) => {
    const cloudApiBase = stack.urls.api;
    const authToken = seededUser.apiKey;
    const api = { apiUrl: cloudApiBase };
    const c = authedClient(cloudApiBase, authToken);

    const prevBoot = getBootConfig();
    const prevToken = readStoredStewardToken();
    setBootConfig({ ...prevBoot, cloudApiBase });
    writeStoredStewardToken(authToken);

    // Price the shared turn's model so the in-Worker billing path can settle a
    // real debit (no live BitRouter key). `openai/<model>` resolves billingSource
    // `openai`→`bitrouter`; seed the `bitrouter` source the lookup short-circuits
    // on. Without this the shared turn 500s before any transcript exists to copy.
    await seedModelPricing({
      model: MODEL,
      billingSource: "bitrouter",
      provider: "openai",
    });

    try {
      const client = new ElizaClient(cloudApiBase, authToken);

      // ── 1. The instant SHARED agent the user chats on. ───────────────────
      // A plain chat agent (openai/<model> character) is a Tier-0 shared
      // runtime — the container-free bridge that is always-available from turn 0.
      const sharedCreate = await c<{
        data?: { id?: string; agentId?: string; executionTier?: string };
      }>("POST", "/api/v1/eliza/agents", {
        agentName: `Shared Front ${Date.now().toString(36)}`,
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
      expect(
        sharedCreate.json.data?.executionTier,
        "the instant front is a shared-tier agent",
      ).toBe("shared");

      // Seed a REAL transcript on the shared agent (canonical conversation id ===
      // agent id, the REST adapter's launch model). Two turns → four messages.
      const convoUrl = `/api/v1/eliza/agents/${sharedAgentId}/api/conversations/${sharedAgentId}/messages`;
      const FIRST = "Remember: my project is codenamed Aurora.";
      const SECOND = "What is my project codenamed?";
      const t1 = await c<{ text?: string }>("POST", convoUrl, { text: FIRST });
      expect(t1.status, "first shared turn accepted").toBe(200);
      const t2 = await c<{ text?: string }>("POST", convoUrl, { text: SECOND });
      expect(t2.status, "second shared turn accepted").toBe(200);

      const sharedHistory = await c<{
        messages?: Array<{ role: string; text: string }>;
      }>("GET", convoUrl);
      expect(
        sharedHistory.json.messages?.length,
        "shared transcript has both turns (user+assistant ×2)",
      ).toBe(4);

      // ── 2. The SEPARATE dedicated agent, provisioned to running. ──────────
      // The handoff target is a distinct `agent_sandboxes` row (the plan's model:
      // a fresh dedicated alongside the shared, NOT an in-place tier re-key). The
      // compat `POST /agents` create reuses the org's single non-terminal agent
      // (one-agent-per-org guard), so insert the dedicated row directly — the same
      // org so the user's token authorizes it — then drive its provision job
      // through the mock control-plane until it's `running` with a reachable
      // bridge base. That is what makes the already-wired handoff reachable.
      const { agentSandboxesRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
      );
      const dedicatedRow = await agentSandboxesRepository.create({
        organization_id: seededUser.organizationId,
        user_id: seededUser.userId,
        agent_name: `Dedicated ${Date.now().toString(36)}`,
        agent_config: {},
        environment_vars: {},
        status: "pending",
        execution_tier: "dedicated-always",
        database_status: "none",
      });
      const dedicatedSandboxId = dedicatedRow.id;
      expect(
        dedicatedSandboxId,
        "dedicated agent is a separate record",
      ).not.toBe(sharedAgentId);
      await startAgentProvisioning(api, authToken, dedicatedSandboxId);
      await pollSandboxStatus(api, authToken, dedicatedSandboxId, "running", {
        timeoutMs: 30_000,
        intervalMs: 250,
        onTick: async () => {
          const result = await stack.mocks.controlPlane.processDbBackedJobs(
            stack.urls.pglite,
          );
          expect(result.failed, JSON.stringify(result.errors)).toBe(0);
        },
      });

      // ── 3. Run the handoff: shared front → dedicated container. ───────────
      const sharedApiBase = `${cloudApiBase.replace(/\/+$/, "")}/api/v1/eliza/agents/${sharedAgentId}`;
      let switchedBase: string | null = null;
      const handoff = await client.startCloudAgentHandoff({
        agentId: sharedAgentId,
        dedicatedAgentId: dedicatedSandboxId,
        sharedApiBase,
        conversationId: sharedAgentId,
        cloudApiBase,
        authToken,
        onSwitch: (base: string) => {
          switchedBase = base;
        },
        intervalMs: 200,
        timeoutMs: 20_000,
        log: (m) => console.log(`[handoff] ${m}`),
      });

      // ── 4. The success contract. ──────────────────────────────────────────
      expect(
        handoff.status,
        `the handoff SWITCHED (did not time out): ${handoff.error ?? ""}`,
      ).toBe("switched");
      expect(
        handoff.imported,
        "every shared turn was imported into the dedicated agent",
      ).toBe(4);
      expect(
        switchedBase,
        "the client switched onto the dedicated container base",
      ).toBeTruthy();
      // Never switch onto the shared REST adapter — the migration target is the
      // dedicated bridge.
      expect(
        switchedBase,
        "switched onto the dedicated base, not the shared adapter",
      ).not.toBe(sharedApiBase);
      expect(
        /\/api\/compat\/agents\//.test(switchedBase ?? ""),
        `switched base is the dedicated container base (${switchedBase})`,
      ).toBe(true);

      // The dedicated agent actually received the transcript, in order, with the
      // conversation id preserved across the switch.
      const dedicatedTranscript =
        stack.mocks.controlPlane.store.getConversationByAgent(
          dedicatedSandboxId,
          sharedAgentId,
        );
      expect(
        dedicatedTranscript.map((m) => m.role),
        "imported transcript preserves the user/assistant ordering",
      ).toEqual(["user", "assistant", "user", "assistant"]);
      expect(
        dedicatedTranscript[0]?.text,
        "the user's first message survived the copy",
      ).toBe(FIRST);
      expect(
        dedicatedTranscript[2]?.text,
        "the user's second message survived the copy",
      ).toBe(SECOND);

      // ── 5. Idempotency: re-running the handoff must not double-import. ─────
      switchedBase = null;
      const replay = await client.startCloudAgentHandoff({
        agentId: sharedAgentId,
        dedicatedAgentId: dedicatedSandboxId,
        sharedApiBase,
        conversationId: sharedAgentId,
        cloudApiBase,
        authToken,
        onSwitch: (base: string) => {
          switchedBase = base;
        },
        intervalMs: 200,
        timeoutMs: 20_000,
      });
      expect(replay.status, "re-run still resolves to a switch").toBe(
        "switched",
      );
      expect(
        replay.imported,
        "re-run inserts nothing (the import is idempotent per conversation)",
      ).toBe(0);
      expect(
        stack.mocks.controlPlane.store.getConversationByAgent(
          dedicatedSandboxId,
          sharedAgentId,
        ).length,
        "the dedicated transcript is unchanged after the idempotent re-run",
      ).toBe(4);
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
