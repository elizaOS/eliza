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
import { browserPlugin } from "../../plugin-browser/src/plugin.ts";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
} from "../../plugin-browser/src/workspace/browser-workspace.ts";
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

const GOOGLE_PLAY_SUBSCRIPTIONS_URL =
  "https://play.google.com/store/account/subscriptions";

const googlePlayFixtureRoutes = [
  {
    url: GOOGLE_PLAY_SUBSCRIPTIONS_URL,
    title: "Google Play Subscriptions",
    body: [
      "<main>",
      "<h1>Google Play</h1>",
      "<h2>Subscriptions</h2>",
      `<form method="get" action="${GOOGLE_PLAY_SUBSCRIPTIONS_URL}">`,
      '<input type="hidden" name="confirm" value="1" />',
      '<button data-lifeops-action="cancel-subscription" type="submit">Cancel subscription</button>',
      "</form>",
      "</main>",
    ].join(""),
  },
  {
    url: `${GOOGLE_PLAY_SUBSCRIPTIONS_URL}?canceled=1`,
    title: "Google Play Cancellation Complete",
    body: [
      "<main>",
      "<h1>Google Play</h1>",
      "<p>subscription canceled</p>",
      "</main>",
    ].join(""),
  },
  {
    url: `${GOOGLE_PLAY_SUBSCRIPTIONS_URL}?confirm=1`,
    title: "Google Play Confirm Cancellation",
    body: [
      "<main>",
      "<h1>Google Play</h1>",
      "<p>Confirm cancellation</p>",
      `<form method="get" action="${GOOGLE_PLAY_SUBSCRIPTIONS_URL}">`,
      '<input type="hidden" name="canceled" value="1" />',
      '<button data-lifeops-action="confirm-cancellation" type="submit">Confirm cancellation</button>',
      "</form>",
      "</main>",
    ].join(""),
  },
] as const;

async function seedGooglePlayWorkspaceFixture(): Promise<void> {
  delete process.env.ELIZA_BROWSER_WORKSPACE_URL;
  delete process.env.ELIZA_BROWSER_WORKSPACE_TOKEN;
  __resetBrowserWorkspaceStateForTests();

  const opened = await executeBrowserWorkspaceCommand({
    show: true,
    subaction: "open",
    title: "Google Play Fixture",
    url: "about:blank",
  });
  const tabId = opened.tab?.id;
  if (!tabId) {
    throw new Error(
      "browser workspace did not create a Google Play fixture tab",
    );
  }

  for (const route of googlePlayFixtureRoutes) {
    await executeBrowserWorkspaceCommand({
      id: tabId,
      networkAction: "route",
      responseBody: [
        "<!doctype html>",
        "<html>",
        `<head><title>${route.title}</title></head>`,
        `<body>${route.body}</body>`,
        "</html>",
      ].join(""),
      responseStatus: 200,
      subaction: "network",
      url: route.url,
    });
  }
}

describe("SubscriptionsService — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "subscriptions-real-db-tests",
      plugins: [financesPlugin, browserPlugin],
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
      expect(
        summary.cancellation.status,
        JSON.stringify(summary.cancellation, null, 2),
      ).toBe("completed");

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

  it("drives an agent_browser cancellation through BrowserService workspace when computeruse is absent", async () => {
    await seedGooglePlayWorkspaceFixture();

    type RuntimeGetService = AgentRuntime["getService"];
    const mutableRuntime = runtime as AgentRuntime & {
      getService: RuntimeGetService;
    };
    const originalGetService = mutableRuntime.getService.bind(runtime);
    mutableRuntime.getService = ((serviceType: string) => {
      if (serviceType === "computeruse") {
        return null;
      }
      return originalGetService(serviceType);
    }) as RuntimeGetService;

    try {
      const service = new SubscriptionsService(runtime, {
        gmailGateway: emptyGmail,
        browserGateway: noCompanionBrowser,
      });
      const summary = await service.cancelSubscription({
        serviceSlug: "google_play",
        executor: "agent_browser",
        confirmed: true,
      });

      if (summary.cancellation.status !== "completed") {
        throw new Error(JSON.stringify(summary.cancellation, null, 2));
      }
      expect(summary.cancellation.artifactCount).toBeGreaterThanOrEqual(1);
      expect(summary.cancellation.evidenceSummary).toBe(
        "subscription canceled",
      );
      expect(summary.cancellation.metadata.artifacts).toEqual([
        expect.objectContaining({
          kind: "screenshot",
          label: "google-play-cancelled",
        }),
      ]);
    } finally {
      mutableRuntime.getService = originalGetService as RuntimeGetService;
      __resetBrowserWorkspaceStateForTests();
    }
  }, 30_000);

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
