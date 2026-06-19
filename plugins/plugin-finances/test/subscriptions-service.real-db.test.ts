/**
 * Real-DB integration tests for the subscriptions back-end.
 *
 * Boots a REAL PGLite-backed AgentRuntime via {@link createRealTestRuntime},
 * registers `financesPlugin` so the SQL plugin materializes the `app_finances`
 * tables (including the subscription audit / candidate / cancellation tables),
 * then exercises {@link SubscriptionsService} against that live database.
 *
 * The two cross-domain runtime-service seams (Gmail + browser bridge) are
 * mocked: the service takes them as injectable options, so these tests stay
 * hermetic (no Google, no browser companion) while every DB read/write is a
 * real round-trip. The `agent_browser` cancellation path mocks the
 * `computeruse` runtime service.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
import financesPlugin from "../src/plugin.ts";
import type { SubscriptionsBrowserGateway } from "../src/services/browser-bridge-seam.ts";
import type { SubscriptionsGmailGateway } from "../src/services/gmail-seam.ts";
import { SubscriptionsService } from "../src/services/subscriptions-service.ts";

function gmailMessage(overrides: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id: "msg-1",
    externalId: "msg-1",
    agentId: "agent",
    provider: "google" as const,
    side: "owner" as const,
    threadId: "thread-1",
    subject: "Your receipt",
    from: "billing@fixture-streaming.example",
    fromEmail: "billing@fixture-streaming.example",
    replyTo: null,
    to: [],
    cc: [],
    snippet: "Thanks for your monthly plan receipt",
    receivedAt: now,
    isUnread: false,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 40,
    triageReason: "Recent Gmail message.",
    labels: [],
    htmlLink: null,
    metadata: {},
    syncedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const emptyGmail: SubscriptionsGmailGateway = {
  async searchSubscriptionMessages() {
    return [];
  },
};

const noCompanionBrowser: SubscriptionsBrowserGateway = {
  async listBrowserCompanions() {
    return [];
  },
  async createBrowserSession() {
    throw new Error("createBrowserSession should not be called");
  },
  async getBrowserSession() {
    throw new Error("getBrowserSession should not be called");
  },
};

describe("SubscriptionsService — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "subscriptions-real-db-tests",
      plugins: [financesPlugin],
    });
    runtime = testResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("audits subscriptions from mocked Gmail evidence and persists the audit", async () => {
    const gmail: SubscriptionsGmailGateway = {
      async searchSubscriptionMessages() {
        return [
          // Scores against the `fixture_streaming` playbook (alias + keyword +
          // domain markers in the blob).
          gmailMessage({
            id: "msg-fixture",
            subject: "Fixture Streaming monthly plan receipt",
            snippet: "Your $9.99 monthly plan from fixture-streaming.example",
            from: "fixture streaming <billing@fixture-streaming.example>",
            fromEmail: "billing@fixture-streaming.example",
          }),
        ];
      },
    };
    const service = new SubscriptionsService(runtime, {
      gmailGateway: gmail,
      browserGateway: noCompanionBrowser,
    });

    const summary = await service.auditSubscriptions({ queryWindowDays: 90 });
    expect(summary.audit.source).toBe("gmail");
    expect(summary.audit.status).toBe("completed");
    const fixture = summary.candidates.find(
      (c) => c.serviceSlug === "fixture_streaming",
    );
    expect(fixture).toBeTruthy();
    expect(fixture?.cadence).toBe("monthly");
    expect(fixture?.annualCostEstimateUsd).toBeCloseTo(9.99 * 12, 2);

    // Round-trip: the latest audit reads back from the real DB.
    const latest = await service.getLatestSubscriptionAudit();
    expect(latest?.audit.id).toBe(summary.audit.id);
    expect(
      latest?.candidates.some((c) => c.serviceSlug === "fixture_streaming"),
    ).toBe(true);
  });

  it("falls back to a manual audit when Gmail throws and a serviceQuery is given", async () => {
    const gmail: SubscriptionsGmailGateway = {
      async searchSubscriptionMessages() {
        throw new Error("Google Gmail is not connected.");
      },
    };
    const service = new SubscriptionsService(runtime, {
      gmailGateway: gmail,
      browserGateway: noCompanionBrowser,
    });
    const summary = await service.auditSubscriptions({
      serviceQuery: "Fixture Streaming",
    });
    expect(summary.audit.source).toBe("manual");
    expect(
      summary.candidates.some((c) => c.serviceSlug === "fixture_streaming"),
    ).toBe(true);
  });

  it("returns unsupported_surface for an unknown service (no playbook)", async () => {
    const service = new SubscriptionsService(runtime, {
      gmailGateway: emptyGmail,
      browserGateway: noCompanionBrowser,
    });
    const summary = await service.cancelSubscription({
      serviceName: "Totally Unknown SaaS",
      confirmed: true,
    });
    expect(summary.cancellation.status).toBe("unsupported_surface");

    // Status read-back from the real DB resolves the latest cancellation.
    const status = await service.getSubscriptionCancellationStatus({
      serviceSlug: summary.cancellation.serviceSlug,
    });
    expect(status?.cancellation.id).toBe(summary.cancellation.id);
  });

  it("drives an agent_browser cancellation through a mocked computeruse service", async () => {
    // The fixture_streaming playbook has a confirmable click flow whose
    // cancellation marker is "subscription canceled". A get_dom probe that
    // returns that marker drives the flow to completed.
    const computeruse = {
      async executeBrowserAction(params: {
        action: string;
      }): Promise<Record<string, unknown>> {
        if (params.action === "get_dom") {
          return { success: true, content: "subscription canceled" };
        }
        if (params.action === "screenshot") {
          return { success: true, screenshot: "x".repeat(10) };
        }
        return { success: true, message: "ok" };
      },
    };
    const originalGetService = runtime.getService.bind(runtime);
    // biome-ignore lint/suspicious/noExplicitAny: test seam to inject computeruse
    (runtime as any).getService = (name: string) =>
      name === "computeruse" ? computeruse : originalGetService(name);

    try {
      const service = new SubscriptionsService(runtime, {
        gmailGateway: emptyGmail,
        browserGateway: noCompanionBrowser,
      });
      const summary = await service.cancelSubscription({
        serviceSlug: "fixture_streaming",
        executor: "agent_browser",
        confirmed: true,
      });
      expect(summary.cancellation.status).toBe("completed");

      // Round-trips through the real DB.
      const status = await service.getSubscriptionCancellationStatus({
        cancellationId: summary.cancellation.id,
      });
      expect(status?.cancellation.status).toBe("completed");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore original
      (runtime as any).getService = originalGetService;
    }
  });

  it("creates a user_browser session via the mocked browser gateway", async () => {
    const created: Array<Record<string, unknown>> = [];
    const browser: SubscriptionsBrowserGateway = {
      async listBrowserCompanions() {
        return [
          {
            id: "companion-1",
            browser: "chrome",
            profileId: "default",
            connectionState: "connected",
          } as never,
        ];
      },
      async createBrowserSession(request) {
        created.push(request as unknown as Record<string, unknown>);
        return {
          id: "session-1",
          status: "running",
        } as never;
      },
      async getBrowserSession() {
        return { id: "session-1", status: "running" } as never;
      },
    };
    const service = new SubscriptionsService(runtime, {
      gmailGateway: emptyGmail,
      browserGateway: browser,
    });
    const summary = await service.cancelSubscription({
      serviceSlug: "fixture_streaming",
      executor: "user_browser",
      confirmed: true,
    });
    expect(summary.cancellation.status).toBe("running");
    expect(summary.cancellation.browserSessionId).toBe("session-1");
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toContain("Fixture Streaming");
  });
});
