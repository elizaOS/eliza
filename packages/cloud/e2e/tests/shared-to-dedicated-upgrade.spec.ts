/**
 * Shared→dedicated tier upgrade (#15355), end to end against the real router.
 *
 * `app-client-handoff-success.spec.ts` proves the handoff machinery with a
 * hand-inserted dedicated row; this spec drives the PRODUCT flow instead: the
 * user chats on their rowless account-native Shared Eliza, reads the
 * server-owned Dedicated quote, then
 * explicitly confirms that exact quote to mint the migration target with the
 * identity copied SERVER-side and a real provision job. The mock control-plane
 * boots it to running, and the ui-package upgrade
 * handoff module (`runSharedToDedicatedUpgradeHandoff` — the exact code the
 * console's "Upgrade to Dedicated" action runs) moves the conversation and
 * seals Shared, imports the exact transcript, and atomically switches the
 * account to Dedicated only after the confirmed import.
 *
 * Asserted, in order:
 *   - the runway credit gate: a balance above the create minimum but below
 *     3 days of hosting is refused with the canonical 402 carrying the
 *     ENFORCED threshold, and mints nothing,
 *   - another org's key cannot upgrade the agent (404, no cross-org oracle),
 *   - the Shared identity has no agent_sandboxes row,
 *   - the funded upgrade creates exactly one dedicated-always row and
 *     enqueues a real provision job,
 *   - an immediate retry reattaches to the SAME in-flight target (no second
 *     container),
 *   - chat continuity: every shared turn lands on the dedicated agent in
 *     order with the conversation id preserved,
 *   - the rowless Shared archive remains intact after the switch, while every
 *     new phone/app turn resolves to the Dedicated runtime instead of splitting.
 *   - one canonical Shared reminder is imported, activated on Dedicated, and
 *     retained on Shared only as a committed audit receipt.
 *   - one canonical Shared Todo and its exactly-once mutation receipt are
 *     digest-verified and materialized on Dedicated before the route flips.
 */

import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent";
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
import { runSharedToDedicatedUpgradeHandoff } from "../../../ui/src/cloud/handoff/start-tier-upgrade";
import { authedClient } from "../src/helpers/monetization";
import { pollSandboxStatus } from "../src/helpers/provisioning";
import { retrySharedRuntimeWarming } from "../src/helpers/shared-runtime";
import { expect, test } from "../src/helpers/test-fixtures";

// API-only (no browser). The transcript uses deterministic capability-wall
// turns so this integration proof never needs a provider or a paid action.
test.use({ stackOptions: { frontend: false } });

interface DedicatedQuote {
  action: "activate_dedicated";
  quoteId: string;
}

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

    try {
      // ── 1. The account-native Shared identity has no sandbox row. ──────
      const sharedAgentId = personalSharedAgentId({
        userId: seededUser.userId,
        organizationId: seededUser.organizationId,
      });
      const { agentSandboxesRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
      );
      expect(
        (
          await agentSandboxesRepository.listByOrganization(
            seededUser.organizationId,
          )
        ).some((row) => row.id === sharedAgentId),
        "personal Shared remains rowless",
      ).toBe(false);

      // ── 2. A real conversation on the account-scoped Shared route. ─────
      // Shared-tier routes resolve scope/billing `cacheOnly`, so a brand-new
      // agent answers the retryable warming 503 until each cache is hydrated
      // under waitUntil. Poll that documented signal (and only it).
      const convoUrl = `/api/v1/eliza/agents/${encodeURIComponent(
        sharedAgentId,
      )}/api/conversations/${encodeURIComponent(sharedAgentId)}/messages`;
      const FIRST = "save this as a note";
      const SECOND = "set a reminder for Friday";
      const sendTurn = (text: string, clientMessageId: string) =>
        retrySharedRuntimeWarming(() =>
          c("POST", convoUrl, { text, clientMessageId }),
        );
      const firstTurn = await sendTurn(FIRST, "personal-upgrade-1");
      expect(
        firstTurn.status,
        `first shared turn: ${JSON.stringify(firstTurn.json)}`,
      ).toBe(200);
      const secondTurn = await sendTurn(SECOND, "personal-upgrade-2");
      expect(
        secondTurn.status,
        `second shared turn: ${JSON.stringify(secondTurn.json)}`,
      ).toBe(200);
      const sharedHistory = await retrySharedRuntimeWarming(() =>
        c<{ messages?: Array<{ role: string; text: string }> }>(
          "GET",
          convoUrl,
        ),
      );
      expect(
        sharedHistory.json.messages?.length,
        "shared transcript has both turns (user+assistant ×2)",
      ).toBe(4);
      const sharedIdentity = await c<{
        data?: { identity?: { id?: string; runtime?: string } };
      }>("GET", "/api/v1/eliza/personal");
      expect(
        sharedIdentity.status,
        `personal identity: ${JSON.stringify(sharedIdentity.json)}`,
      ).toBe(200);
      expect(sharedIdentity.json.data?.identity).toMatchObject({
        id: sharedAgentId,
        runtime: "shared",
      });

      const { createSharedScheduledTaskRunner, executeSharedSchedulingSql } =
        await import(
          "@elizaos/cloud-shared/lib/services/shared-runtime/shared-scheduling"
        );
      const sharedTaskRunner = createSharedScheduledTaskRunner(sharedAgentId, {
        dispatch: async () => undefined,
      });
      const scheduledReminder = await sharedTaskRunner.schedule({
        kind: "reminder",
        promptInstructions: "call mom",
        trigger: { kind: "once", atIso: "2026-08-16T17:00:00.000Z" },
        priority: "medium",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: seededUser.userId,
        ownerVisible: true,
        executionProfile: "notify-only",
        metadata: {
          delivery: {
            platform: "telegram",
            project: "eliza-app",
            chatId: "919191",
          },
        },
      });
      expect(await sharedTaskRunner.list()).toMatchObject([
        { taskId: scheduledReminder.taskId, promptInstructions: "call mom" },
      ]);
      const {
        createSharedTodoStore,
        readSharedTodoCutoverState,
        sharedTodoStorageScope,
      } = await import(
        "@elizaos/cloud-shared/lib/services/shared-runtime/shared-todos"
      );
      const sharedTodoStore = createSharedTodoStore();
      const sharedTodoScope = sharedTodoStorageScope({
        sourceAgentId: sharedAgentId,
        ownerId: seededUser.userId,
      });
      const sharedTodoMutation = await sharedTodoStore.applyMutation({
        scope: sharedTodoScope,
        idempotencyKey: "personal-upgrade-todo:create",
        mutation: {
          action: "create",
          input: {
            roomId: "a5150000-0000-4000-8000-000000000001",
            content: "Call mom before Friday",
            activeForm: "Calling mom before Friday",
            status: "pending",
            metadata: { source: "shared-upgrade-e2e" },
          },
        },
      });
      if (sharedTodoMutation.result.action !== "create") {
        throw new Error("Shared Todo setup did not return its created row");
      }
      const sharedTodo = sharedTodoMutation.result.todo;
      expect(
        await readSharedTodoCutoverState({
          sourceAgentId: sharedAgentId,
          ownerId: seededUser.userId,
        }),
      ).toMatchObject({
        todos: [{ id: sharedTodo.id, content: sharedTodo.content }],
        mutations: [
          {
            mutationId: sharedTodoMutation.mutationId,
            idempotencyKey: "personal-upgrade-todo:create",
            operation: "create",
            applied: true,
          },
        ],
      });

      // ── 3. Runway credit gate: refused BELOW 3 days of hosting. ────────
      // $0.50 clears the $0.10 create minimum — the gate the create/provision
      // routes use — so this proves upgrade-tier enforces the STRICTER runway.
      await setOrgBalance(seededUser.organizationId, "0.50");
      const gatedQuote = await c<{ data?: DedicatedQuote }>(
        "GET",
        `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`,
      );
      expect(gatedQuote.status).toBe(200);
      expect(gatedQuote.json.data?.action).toBe("activate_dedicated");
      expect(gatedQuote.json.data?.quoteId).toMatch(/^[a-f0-9]{64}$/);
      const gated = await c<{
        code?: string;
        requiredBalance?: number;
        currentBalance?: number;
        error?: string;
      }>("POST", `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`, {
        action: gatedQuote.json.data?.action,
        quoteId: gatedQuote.json.data?.quoteId,
      });
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
      const fundedQuote = await c<{ data?: DedicatedQuote }>(
        "GET",
        `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`,
      );
      expect(fundedQuote.status).toBe(200);
      expect(fundedQuote.json.data?.action).toBe("activate_dedicated");
      expect(fundedQuote.json.data?.quoteId).toMatch(/^[a-f0-9]{64}$/);
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
      }>("POST", `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`, {
        action: fundedQuote.json.data?.action,
        quoteId: fundedQuote.json.data?.quoteId,
      });
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

      const dedicatedRow = await agentSandboxesRepository.findByIdAndOrg(
        dedicatedAgentId,
        seededUser.organizationId,
      );
      expect(dedicatedRow, "dedicated row is org-owned").toBeTruthy();
      expect(dedicatedRow?.execution_tier).toBe("dedicated-always");
      expect(dedicatedRow?.agent_name).toBe("Eliza");
      const dedicatedConfig = dedicatedRow?.agent_config as Record<
        string,
        unknown
      > | null;
      expect(
        dedicatedConfig?.__agentUpgradedFrom,
        "server-side reattach marker recorded",
      ).toBe(sharedAgentId);

      // ── 6. Retry reattaches — never a second container. ────────────────
      const retried = await c<{
        created?: boolean;
        alreadyInProgress?: boolean;
        data?: { dedicatedAgentId?: string };
      }>("POST", `/api/v1/eliza/agents/${sharedAgentId}/upgrade-tier`, {
        action: fundedQuote.json.data?.action,
        quoteId: fundedQuote.json.data?.quoteId,
      });
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
      let cutoverImportedTodos: number | null = null;
      let cutoverImportedTodoMutations: number | null = null;
      const baseClient = new ElizaClient(cloudApiBase, authToken);
      const outcome = await runSharedToDedicatedUpgradeHandoff({
        sharedAgentId,
        dedicatedAgentId,
        cloudApiBase,
        authToken,
        client: {
          startCloudAgentHandoff: (options) =>
            baseClient.startCloudAgentHandoff(options),
          deleteSharedBridgeAgent: (agentId, options) =>
            baseClient.deleteSharedBridgeAgent(agentId, options),
          finalizePersonalDedicatedCutover: async (options) => {
            const response = await c<{
              data?: {
                personalElizaId?: string;
                activeAgentId?: string;
                runtime?: "dedicated";
                apiBase?: string;
                importedMessages?: number;
                importedTodos?: number;
                importedTodoMutations?: number;
              };
            }>(
              "POST",
              `/api/v1/eliza/agents/${encodeURIComponent(options.personalElizaId)}/upgrade-tier/cutover`,
              { dedicatedAgentId: options.dedicatedAgentId },
            );
            if (response.status !== 200) {
              throw new Error(
                `cutover failed (${response.status}): ${JSON.stringify(response.json)}`,
              );
            }
            const data = response.json.data;
            if (
              data?.runtime !== "dedicated" ||
              data.personalElizaId !== options.personalElizaId ||
              data.activeAgentId !== options.dedicatedAgentId ||
              !data.apiBase ||
              typeof data.importedMessages !== "number" ||
              typeof data.importedTodos !== "number" ||
              typeof data.importedTodoMutations !== "number"
            ) {
              throw new Error("cutover returned an invalid Dedicated identity");
            }
            cutoverImportedTodos = data.importedTodos;
            cutoverImportedTodoMutations = data.importedTodoMutations;
            return {
              runtime: data.runtime,
              apiBase: data.apiBase,
              importedMessages: data.importedMessages,
            };
          },
        },
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
      expect(
        cutoverImportedTodos,
        "the exact Shared Todo was confirmed before the route flip",
      ).toBe(1);
      expect(
        cutoverImportedTodoMutations,
        "the exact Shared Todo mutation receipt was confirmed before the route flip",
      ).toBe(1);
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
      expect(
        await executeSharedSchedulingSql(
          `SELECT transfer_status FROM app_scheduling.life_scheduled_tasks WHERE id = '${scheduledReminder.taskId}'`,
        ),
        "Shared retains a committed audit receipt after Dedicated activation",
      ).toMatchObject([{ transfer_status: "committed" }]);
      expect(
        stack.mocks.controlPlane.store.getScheduledTasksByAgent(
          dedicatedAgentId,
          sharedAgentId,
        ),
        "the exact Shared reminder is imported and activated only after cutover",
      ).toMatchObject([
        {
          task: {
            taskId: scheduledReminder.taskId,
            promptInstructions: "call mom",
          },
          sourceAgentId: sharedAgentId,
          cutoverToken: `personal-cutover:${sharedAgentId}:${dedicatedAgentId}`,
          active: true,
        },
      ]);
      expect(
        stack.mocks.controlPlane.store.getTodosByAgent(
          dedicatedAgentId,
          sharedAgentId,
        ),
        "the canonical Shared Todo is materialized on Dedicated",
      ).toMatchObject([
        {
          sourceId: sharedTodo.id,
          content: "Call mom before Friday",
          activeForm: "Calling mom before Friday",
          metadata: { source: "shared-upgrade-e2e" },
        },
      ]);
      expect(
        stack.mocks.controlPlane.store.getTodoMutationsByAgent(
          dedicatedAgentId,
          sharedAgentId,
        ),
        "the exact replay authority is materialized with the Todo",
      ).toMatchObject([
        {
          mutationId: sharedTodoMutation.mutationId,
          idempotencyKey: "personal-upgrade-todo:create",
          operation: "create",
          applied: true,
          committedAt: sharedTodoMutation.committedAt.toISOString(),
        },
      ]);
      expect(
        await readSharedTodoCutoverState({
          sourceAgentId: sharedAgentId,
          ownerId: seededUser.userId,
        }),
        "Shared retains the source Todo and receipt archive after the confirmed switch",
      ).toMatchObject({
        todos: [{ id: sharedTodo.id }],
        mutations: [
          {
            mutationId: sharedTodoMutation.mutationId,
            idempotencyKey: "personal-upgrade-todo:create",
          },
        ],
      });

      // ── 9. Shared stays archived; every new turn resolves Dedicated. ────
      expect(
        outcome.sourceCleanup,
        "the rowless Shared archive survives the confirmed switch",
      ).toBe("preserved-rowless");
      expect(
        (
          await agentSandboxesRepository.listByOrganization(
            seededUser.organizationId,
          )
        ).some((row) => row.id === sharedAgentId),
        "no Shared row was introduced",
      ).toBe(false);

      const active = await c<{
        data?: {
          identity?: {
            id?: string;
            runtime?: string;
            activeAgentId?: string;
          };
        };
      }>("GET", "/api/v1/eliza/personal");
      expect(active.status).toBe(200);
      expect(active.json.data?.identity).toMatchObject({
        id: sharedAgentId,
        runtime: "dedicated",
        activeAgentId: dedicatedAgentId,
      });

      const { usersRepository } = await import(
        "@elizaos/cloud-shared/db/repositories/users"
      );
      const connectorPhone = "+14155550987";
      const linked = await usersRepository.linkVerifiedPhone(
        seededUser.userId,
        connectorPhone,
      );
      expect(linked?.id, "phone transport resolves the existing account").toBe(
        seededUser.userId,
      );
      const connectorResponse = await fetch(
        `${cloudApiBase}/api/internal/eliza-app/personal-shared/messages`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-internal-secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            platform: "blooio",
            project: "eliza-app",
            phoneNumber: connectorPhone,
            messageId: "blooio:eliza-app:after-cutover",
            message: "Continue this exact conversation from my phone.",
          }),
        },
      );
      expect(
        connectorResponse.status,
        `connector turn: ${await connectorResponse.clone().text()}`,
      ).toBe(200);
      const connectorPayload = (await connectorResponse.json()) as {
        data?: {
          identity?: {
            id?: string;
            runtime?: string;
            activeAgentId?: string;
          };
        };
      };
      expect(connectorPayload.data?.identity).toMatchObject({
        id: sharedAgentId,
        runtime: "dedicated",
        activeAgentId: dedicatedAgentId,
      });
      const connectorTranscript =
        stack.mocks.controlPlane.store.getConversationByAgent(
          dedicatedAgentId,
          sharedAgentId,
        );
      expect(
        connectorTranscript.map((message) => message.role),
        "the connector appends to the imported canonical room",
      ).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(connectorTranscript[4]?.text).toBe(
        "Continue this exact conversation from my phone.",
      );
      const connectorRetry = await fetch(
        `${cloudApiBase}/api/internal/eliza-app/personal-shared/messages`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer test-internal-secret",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            platform: "blooio",
            project: "eliza-app",
            phoneNumber: connectorPhone,
            messageId: "blooio:eliza-app:after-cutover",
            message: "Continue this exact conversation from my phone.",
          }),
        },
      );
      expect(connectorRetry.status, "connector retry is replay-safe").toBe(200);
      expect(
        stack.mocks.controlPlane.store.getConversationByAgent(
          dedicatedAgentId,
          sharedAgentId,
        ),
        "the stable provider message id prevents duplicate turns",
      ).toHaveLength(6);

      const splitTurn = await c<{ code?: string }>("POST", convoUrl, {
        text: "This must not create a new Shared turn.",
        clientMessageId: "personal-after-cutover",
      });
      expect(
        splitTurn.status,
        `stale Shared turn must fail: ${JSON.stringify(splitTurn.json)}`,
      ).not.toBe(200);
      const archivedHistory = await c<{
        messages?: Array<{ role: string; text: string }>;
      }>("GET", convoUrl);
      expect(
        archivedHistory.json.messages?.length,
        "a stale client cannot append to the sealed Shared transcript",
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
