import { describe, expect, test } from "vitest";
import type { AgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";
import {
  attachFakeSubscriptionComputerUse,
  FakeSubscriptionComputerUseService,
} from "../../../../test/helpers/subscription-computer-use-fixture";

function createRuntime(agentId: string): AgentRuntime {
  return createLifeOpsChatTestRuntime({
    agentId,
    handleTurn: async () => ({ text: "ok" }),
    useModel: async () => {
      throw new Error("useModel should not be called in subscriptions tests");
    },
  });
}

async function createService(
  agentId: string,
  options?: {
    browserCompanion?: boolean;
    computerUseService?: FakeSubscriptionComputerUseService;
  },
): Promise<{ runtime: AgentRuntime; service: LifeOpsService }> {
  const runtime = createRuntime(agentId);
  await LifeOpsRepository.bootstrapSchema(runtime);
  if (options?.computerUseService) {
    attachFakeSubscriptionComputerUse(runtime, options.computerUseService);
  }
  const service = new LifeOpsService(runtime);
  await service.updateBrowserSettings({
    enabled: true,
    allowBrowserControl: true,
  });
  if (options?.browserCompanion) {
    await service.syncBrowserState({
      companion: {
        browser: "chrome",
        profileId: "profile-1",
        label: "LifeOps Browser Chrome",
        connectionState: "connected",
        permissions: {
          tabs: true,
          scripting: true,
          activeTab: true,
          allOrigins: true,
          grantedOrigins: ["https://play.google.com"],
          incognitoEnabled: false,
        },
      },
      tabs: [
        {
          browser: "chrome",
          profileId: "profile-1",
          windowId: "window-1",
          tabId: "tab-1",
          url: "https://example.com",
          title: "Example",
          activeInWindow: true,
          focusedWindow: true,
          focusedActive: true,
        },
      ],
      pageContexts: [
        {
          browser: "chrome",
          profileId: "profile-1",
          windowId: "window-1",
          tabId: "tab-1",
          url: "https://example.com",
          title: "Example",
          mainText: "Example",
        },
      ],
    });
  }
  return { runtime, service };
}

function gmailMessage(args: {
  id: string;
  subject: string;
  snippet: string;
  from: string;
  fromEmail?: string | null;
}): {
  id: string;
  externalId: string;
  agentId: string;
  provider: "google";
  side: "owner";
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isImportant: boolean;
  likelyReplyNeeded: boolean;
  triageScore: number;
  triageReason: string;
  labels: string[];
  htmlLink: string | null;
  metadata: Record<string, unknown>;
  syncedAt: string;
  updatedAt: string;
} {
  const now = new Date().toISOString();
  return {
    id: args.id,
    externalId: args.id,
    agentId: "agent",
    provider: "google",
    side: "owner",
    threadId: `${args.id}-thread`,
    subject: args.subject,
    from: args.from,
    fromEmail: args.fromEmail ?? null,
    replyTo: null,
    to: [],
    cc: [],
    snippet: args.snippet,
    receivedAt: now,
    isUnread: true,
    isImportant: true,
    likelyReplyNeeded: false,
    triageScore: 0.9,
    triageReason: "subscription",
    labels: [],
    htmlLink: null,
    metadata: {},
    syncedAt: now,
    updatedAt: now,
  };
}

describe("LifeOps subscriptions integration", () => {
  test("audits subscriptions from Gmail evidence", async () => {
    const { service } = await createService("lifeops-subscriptions-audit");
    service.getGmailTriage = async () => ({
      source: "cache",
      syncedAt: new Date().toISOString(),
      summary: {
        unreadCount: 2,
        importantNewCount: 2,
        likelyReplyNeededCount: 0,
      },
      messages: [
        gmailMessage({
          id: "msg-google",
          subject: "Google Play subscription renewal receipt",
          snippet: "Your monthly plan was billed at $7.99",
          from: "Google Play",
          fromEmail: "googleplay-noreply@google.com",
        }),
        gmailMessage({
          id: "msg-apple",
          subject: "Apple subscription canceled",
          snippet: "Your subscription canceled and expires on May 1",
          from: "Apple",
          fromEmail: "no_reply@email.apple.com",
        }),
      ],
    });

    const summary = await service.auditSubscriptions(new URL("http://127.0.0.1/"));

    expect(summary.audit.totalCandidates).toBeGreaterThanOrEqual(2);
    expect(summary.candidates.map((candidate) => candidate.serviceSlug)).toEqual(
      expect.arrayContaining(["google_play", "apple_subscriptions"]),
    );
  });

  test("creates a browser companion session for personal-browser cancellations", async () => {
    const { service } = await createService(
      "lifeops-subscriptions-browser-session",
      {
        browserCompanion: true,
      },
    );

    const summary = await service.cancelSubscription({
      serviceName: "Google Play",
      executor: "user_browser",
    });

    expect(summary.cancellation.browserSessionId).toBeTruthy();
    expect(["running", "awaiting_confirmation"]).toContain(
      summary.cancellation.status,
    );
  });

  test("completes a supported cancellation through the local browser executor", async () => {
    const { service } = await createService(
      "lifeops-subscriptions-agent-browser-complete",
      {
        computerUseService: new FakeSubscriptionComputerUseService(
          "fixture_streaming",
        ),
      },
    );

    const summary = await service.cancelSubscription({
      serviceName: "Fixture Streaming",
      executor: "agent_browser",
      confirmed: true,
    });

    expect(summary.cancellation.status).toBe("completed");
    expect(summary.cancellation.artifactCount).toBeGreaterThan(0);
  });

  test("stops before the destructive step when confirmation was not given", async () => {
    const { service } = await createService(
      "lifeops-subscriptions-agent-browser-awaiting-confirmation",
      {
        computerUseService: new FakeSubscriptionComputerUseService(
          "fixture_streaming",
        ),
      },
    );

    const summary = await service.cancelSubscription({
      serviceName: "Fixture Streaming",
      executor: "agent_browser",
      confirmed: false,
    });

    expect(summary.cancellation.status).toBe("awaiting_confirmation");
    expect(summary.cancellation.finishedAt).toBeNull();
  });

  test("surfaces login-required cancellations as a human handoff", async () => {
    const { service } = await createService(
      "lifeops-subscriptions-agent-browser-login-required",
      {
        computerUseService: new FakeSubscriptionComputerUseService(
          "fixture_login_required",
        ),
      },
    );

    const summary = await service.cancelSubscription({
      serviceName: "Fixture Login Required",
      executor: "agent_browser",
      confirmed: true,
    });

    expect(summary.cancellation.status).toBe("needs_login");
  });
});
