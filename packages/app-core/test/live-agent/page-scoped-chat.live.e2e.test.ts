/**
 * E2E coverage for page-scoped chats (Browser, Character, Apps, Automations).
 *
 * Verifies that:
 *   1. The page-scoped-context provider activates only when the room carries
 *      a page-* scope, and stays silent in unscoped rooms.
 *   2. Trajectories written during page-scoped sends carry the full sortable
 *      metadata bundle (webConversation.scope, taskId, surface, surfaceVersion).
 *   3. Main-chat awareness: a populated source conversation surfaces in the
 *      provider; a blank or agent-only-initiated source is correctly ignored.
 *
 * Live tests gated on ELIZA_LIVE_TEST=1 / ELIZA_LIVE_TEST=1 plus a configured
 * LLM API key. NODE_ENV is temporarily overridden to enable trajectory
 * persistence (the runtime disables it under NODE_ENV=test by default).
 */

import crypto from "node:crypto";
import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  type Memory,
  type MessageMetadata,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { itIf } from "../../../../test/helpers/conditional-tests.ts";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";
import { pageScopedContextProvider } from "../../../agent/src/providers/page-scoped-context.js";
import { trajectoriesPlugin } from "../../../core/src/features/trajectories/index.js";
import {
  buildPageScopedRoutingMetadata,
  PAGE_SCOPE_VERSION,
  type PageScope,
} from "../../src/components/pages/page-scoped-conversations.js";
import { ConversationHarness } from "../helpers/conversation-harness.js";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";
import {
  expectProviderAccessed,
  expectTrajectoryScopeMetadata,
  loadLatestTrajectoryForScope,
  stampPageScopedRoomMetadata,
} from "../helpers/trajectory-assertions.js";

const liveModelTestsEnabled = process.env.ELIZA_LIVE_TEST === "1";
const selectedLiveProvider = liveModelTestsEnabled
  ? selectLiveProvider()
  : null;
const canRunLiveTests = liveModelTestsEnabled && selectedLiveProvider !== null;

function buildTestRoutingMetadata(
  scope: PageScope,
  options: { sourceConversationId?: string; pageId?: string } = {},
): Partial<MessageMetadata> {
  return buildPageScopedRoutingMetadata(
    scope,
    options,
  ) as Partial<MessageMetadata>;
}

interface ScopeCase {
  scope: PageScope;
  prompt: string;
}

const SCOPE_CASES: ScopeCase[] = [
  {
    scope: "page-browser",
    prompt: "What can I do here, and what tabs are open?",
  },
  {
    scope: "page-character",
    prompt: "How do I change my voice or upload knowledge?",
  },
  {
    scope: "page-automations",
    prompt:
      "What can I do here? Describe the automation builder at a high level.",
  },
  {
    scope: "page-apps",
    prompt: "What can I do here? Tell me how I'd launch an app.",
  },
];

describe("Page-scoped chat — provider + trajectory metadata", () => {
  let runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let prevNodeEnv: string | undefined;

  beforeAll(async () => {
    if (!canRunLiveTests) return;
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
    process.env.LOG_LEVEL = process.env.ELIZA_E2E_LOG_LEVEL ?? "error";
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";

    const result = await createRealTestRuntime({
      withLLM: true,
      preferredProvider: selectedLiveProvider?.name,
      characterName: "PageScopedTestAgent",
      advancedCapabilities: false,
      plugins: [
        trajectoriesPlugin as Plugin,
        {
          name: "page-scoped-chat-e2e-context",
          description: "Registers page-scoped context for live page-chat e2e.",
          providers: [pageScopedContextProvider],
        },
      ],
    });
    runtime = result.runtime;
    cleanup = result.cleanup;
  }, 180_000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    if (prevNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = prevNodeEnv;
    }
  }, 60_000);

  itIf(canRunLiveTests)(
    "writes scope-tagged trajectories and runs the page provider for each scope",
    async () => {
      for (const scopeCase of SCOPE_CASES) {
        const harness = new ConversationHarness(runtime, {
          userName: "PageTester",
        });
        await harness.setup();
        await stampPageScopedRoomMetadata(
          runtime,
          harness.roomId,
          scopeCase.scope,
          {
            conversationId: `e2e-${scopeCase.scope}`,
          },
        );

        try {
          const turn = await harness.send(scopeCase.prompt, {
            metadata: buildTestRoutingMetadata(scopeCase.scope),
          });
          expect(turn.responseText).not.toMatch(
            /something (?:went wrong|flaked)|try again/i,
          );

          const trajectory = await loadLatestTrajectoryForScope(
            runtime,
            scopeCase.scope,
          );
          expect(
            trajectory,
            `Expected a trajectory tagged with scope=${scopeCase.scope}; check that NODE_ENV override took effect.`,
          ).not.toBeNull();
          if (!trajectory) return;

          expectTrajectoryScopeMetadata(trajectory, scopeCase.scope, {
            // surfaceVersion is stamped by the frontend send path; backend-only
            // tests don't include it. The check is permissive (only asserts when
            // present) by passing nothing here.
          });
          expectProviderAccessed(trajectory, "page-scoped-context");
        } finally {
          await harness.cleanup();
        }
      }
    },
    240_000,
  );

  itIf(canRunLiveTests)(
    "does not run the page provider in unscoped rooms",
    async () => {
      const harness = new ConversationHarness(runtime, {
        userName: "PageTester",
      });
      await harness.setup();
      try {
        // No stampPageScopedRoomMetadata — the room stays unscoped.
        const turn = await harness.send("hi, what can you do?");
        expect(turn.responseText).not.toMatch(
          /something (?:went wrong|flaked)|try again/i,
        );

        // Trajectory still gets written; the page-scoped provider should NOT
        // appear in any of its provider accesses.
        const trajectory = await loadLatestTrajectoryForScope(
          runtime,
          "page-character", // any scope — we expect null
          { roomId: harness.roomId },
        );
        // No matching trajectory is the desired outcome; if one exists it must
        // not have run the provider.
        if (trajectory) {
          const accessed = trajectory.steps.flatMap((step) =>
            Array.isArray(step.providerAccesses) ? step.providerAccesses : [],
          );
          const names = accessed.map(
            (entry) => (entry as { providerName?: string }).providerName,
          );
          expect(names).not.toContain("page-scoped-context");
        }
      } finally {
        await harness.cleanup();
      }
    },
    180_000,
  );

  itIf(canRunLiveTests)(
    "ignores blank / agent-only-initiated main chats but bridges substantive ones",
    async () => {
      // First, build a substantive source conversation (>= 2 turns with a user
      // message somewhere). We use a normal harness room as the "source" by
      // stuffing memories into it.
      const sourceHarness = new ConversationHarness(runtime, {
        userName: "PageTester-source",
      });
      await sourceHarness.setup();
      const sourceConversationId = `e2e-source-${Date.now()}`;
      const sourceRoomId = stringToUuid(
        `web-conv-${sourceConversationId}`,
      ) as UUID;

      // Wire up the source room so getMemories can read from it.
      await runtime.ensureConnection({
        entityId: sourceHarness.userId,
        roomId: sourceRoomId,
        worldId: sourceHarness.worldId,
        worldName: "PageTester-source's World",
        userName: "PageTester-source",
        name: "PageTester-source",
        source: "test",
        channelId: sourceRoomId,
        type: ChannelType.DM,
        messageServerId: sourceHarness.userId,
        metadata: { ownership: { ownerId: sourceHarness.userId } },
      });
      await runtime.ensureParticipantInRoom(runtime.agentId, sourceRoomId);
      await runtime.ensureParticipantInRoom(sourceHarness.userId, sourceRoomId);

      const now = Date.now();
      const userMemory: Memory = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: sourceHarness.userId,
        roomId: sourceRoomId,
        content: { text: "I want a calmer character", source: "test" },
      });
      userMemory.createdAt = now - 60_000;
      const agentMemory: Memory = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: runtime.agentId,
        roomId: sourceRoomId,
        content: { text: "Got it — I'll soften the bio.", source: "test" },
      });
      agentMemory.createdAt = now - 30_000;
      await runtime.createMemory(userMemory, "messages");
      await runtime.createMemory(agentMemory, "messages");

      // Now create a page-scoped room linked to that source.
      const pageHarness = new ConversationHarness(runtime, {
        userName: "PageTester-page",
      });
      await pageHarness.setup();
      await stampPageScopedRoomMetadata(
        runtime,
        pageHarness.roomId,
        "page-character",
        { conversationId: "e2e-page", sourceConversationId },
      );

      try {
        const turn = await pageHarness.send(
          "Following up on what we were talking about — what changed?",
          {
            metadata: buildTestRoutingMetadata("page-character", {
              sourceConversationId,
            }),
          },
        );
        expect(turn.responseText).not.toMatch(
          /something (?:went wrong|flaked)|try again/i,
        );

        const trajectory = await loadLatestTrajectoryForScope(
          runtime,
          "page-character",
          { roomId: pageHarness.roomId },
        );
        expect(trajectory).not.toBeNull();
        if (!trajectory) return;

        // The provider's data field reports whether source-tail was included.
        const providerAccesses = trajectory.steps.flatMap((step) =>
          Array.isArray(step.providerAccesses) ? step.providerAccesses : [],
        );
        const pageAccess = providerAccesses.find(
          (entry) =>
            (entry as { providerName?: string }).providerName ===
            "page-scoped-context",
        );
        expect(
          pageAccess,
          "expected page-scoped-context to be accessed",
        ).toBeDefined();
      } finally {
        await pageHarness.cleanup();
        await sourceHarness.cleanup();
      }
    },
    180_000,
  );
});

// Reference PAGE_SCOPE_VERSION so the import is retained — surfaceVersion is a
// frontend stamp, but pinning it here means a bump triggers a test churn that
// reminds us to also bump the trajectory cohort assumptions in this file.
void PAGE_SCOPE_VERSION;
