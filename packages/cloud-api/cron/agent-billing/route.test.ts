import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

const runningSandbox = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  agent_name: "Waifu Agent",
  organization_id: "agent-org",
  user_id: "agent-user",
  agent_config: {
    waifuAgentId: "waifu-agent-1",
    tokenContractAddress: "0x0000000000000000000000000000000000000009",
    chain: "bsc",
    chainId: 56,
    account: {
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
    },
    waifuWebhook: {
      url: "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
      secret: "test-webhook-secret",
    },
  },
  status: "running",
  billing_status: "active",
  last_billed_at: null,
  total_billed: "0",
  shutdown_warning_sent_at: null as Date | null,
  scheduled_shutdown_at: null as Date | null,
};

const listBillableSandboxes = mock(async () => ({
  runningSandboxes: [runningSandbox],
  stoppedWithBackups: [],
}));
const listBillingOrganizations = mock(async () => [
  {
    id: "agent-org",
    name: "Agent Org",
    credit_balance: "0",
    billing_email: "billing@example.test",
  },
]);
const recordHourlyBilling = mock(async () => ({
  status: "insufficient_credits",
}));
const getOrganizationCreditBalance = mock(async () => 0);
const scheduleShutdownWarning = mock(async () => undefined);
const suspendSandboxForInsufficientCredits = mock(async () => undefined);
const shutdownSandbox = mock(async () => ({ success: true }));
const sendContainerShutdownWarningEmail = mock(async () => undefined);
const webhookFetch = mock(async (_url: string | URL | Request, _init?: RequestInit) =>
  Response.json({ ok: true }),
);

mock.module("@/db/repositories/agent-billing", () => ({
  agentBillingRepository: {
    listBillableSandboxes,
    listBillingOrganizations,
    recordHourlyBilling,
    getOrganizationCreditBalance,
    scheduleShutdownWarning,
    suspendSandboxForInsufficientCredits,
  },
}));

mock.module("@/db/repositories", () => ({
  usersRepository: {
    listByOrganization: mock(async () => []),
  },
}));

mock.module("@/lib/services/email", () => ({
  emailService: {
    sendContainerShutdownWarningEmail,
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    shutdown: shutdownSandbox,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

describe("agent billing cron waifu lifecycle callbacks", () => {
  beforeEach(() => {
    listBillableSandboxes.mockClear();
    listBillingOrganizations.mockClear();
    recordHourlyBilling.mockClear();
    getOrganizationCreditBalance.mockClear();
    scheduleShutdownWarning.mockClear();
    suspendSandboxForInsufficientCredits.mockClear();
    shutdownSandbox.mockClear();
    sendContainerShutdownWarningEmail.mockClear();
    webhookFetch.mockClear();
    globalThis.fetch = webhookFetch as unknown as typeof fetch;
    listBillableSandboxes.mockImplementation(async () => ({
      runningSandboxes: [runningSandbox],
      stoppedWithBackups: [],
    }));
    listBillingOrganizations.mockImplementation(async () => [
      {
        id: "agent-org",
        name: "Agent Org",
        credit_balance: "0",
        billing_email: "billing@example.test",
      },
    ]);
    recordHourlyBilling.mockImplementation(async () => ({
      status: "insufficient_credits",
    }));
    getOrganizationCreditBalance.mockImplementation(async () => 0);
    shutdownSandbox.mockImplementation(async () => ({ success: true }));
  });

  test("sends a signed credits.low webhook when an agent runs out of billable balance", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://www.elizacloud.ai",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        sandboxesProcessed: 1,
        warningsSent: 1,
        sandboxesShutdown: 0,
      },
    });
    expect(recordHourlyBilling).toHaveBeenCalledTimes(1);
    expect(scheduleShutdownWarning).toHaveBeenCalledTimes(1);
    expect(webhookFetch).toHaveBeenCalledTimes(1);

    const [url, init] = webhookFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
    );
    const bodyText = String((init as RequestInit).body);
    const body = JSON.parse(bodyText);
    expect(body).toMatchObject({
      event: "credits.low",
      cloudAgentId: runningSandbox.id,
      elizaCloudAgentId: runningSandbox.id,
      agentId: "waifu-agent-1",
      organizationId: "agent-org",
      tokenContractAddress: "0x0000000000000000000000000000000000000009",
      tokenAddress: "0x0000000000000000000000000000000000000009",
      tokenChain: "bsc",
      chain: "bsc",
      chainId: 56,
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
      creditsRemaining: 0,
      requiredCredits: 0.01,
      billingStatus: "active",
      status: "running",
    });
    expect(typeof body.scheduledShutdownAt).toBe("string");
    expectSignedWebhook(init as RequestInit, body.timestamp, bodyText);
  });

  test("suspends and sends credits.depleted webhook after the grace window expires", async () => {
    const scheduledShutdownAt = new Date(Date.now() - 60_000);
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [
        {
          ...runningSandbox,
          billing_status: "shutdown_pending",
          shutdown_warning_sent_at: new Date(Date.now() - 49 * 60 * 60_000),
          scheduled_shutdown_at: scheduledShutdownAt,
        },
      ],
      stoppedWithBackups: [],
    }));

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://www.elizacloud.ai",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        sandboxesProcessed: 1,
        warningsSent: 0,
        sandboxesShutdown: 1,
      },
    });
    expect(recordHourlyBilling).not.toHaveBeenCalled();
    expect(shutdownSandbox).toHaveBeenCalledWith(
      runningSandbox.id,
      "agent-org",
    );
    expect(suspendSandboxForInsufficientCredits).toHaveBeenCalledWith(
      runningSandbox.id,
      expect.any(Date),
    );
    expect(webhookFetch).toHaveBeenCalledTimes(1);

    const [url, init] = webhookFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
    );
    const bodyText = String((init as RequestInit).body);
    const body = JSON.parse(bodyText);
    expect(body).toMatchObject({
      event: "credits.depleted",
      eventId: `agent-billing:${runningSandbox.id}:credits.depleted:${scheduledShutdownAt.toISOString()}`,
      cloudAgentId: runningSandbox.id,
      elizaCloudAgentId: runningSandbox.id,
      agentId: "waifu-agent-1",
      organizationId: "agent-org",
      tokenContractAddress: "0x0000000000000000000000000000000000000009",
      tokenAddress: "0x0000000000000000000000000000000000000009",
      tokenChain: "bsc",
      chain: "bsc",
      chainId: 56,
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
      creditsRemaining: 0,
      requiredCredits: 0.01,
      billingStatus: "shutdown_pending",
      status: "running",
      scheduledShutdownAt: scheduledShutdownAt.toISOString(),
    });
    expectSignedWebhook(init as RequestInit, body.timestamp, bodyText);
  });

  test("does not mark credits depleted if the container shutdown fails", async () => {
    const scheduledShutdownAt = new Date(Date.now() - 60_000);
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [
        {
          ...runningSandbox,
          billing_status: "shutdown_pending",
          shutdown_warning_sent_at: new Date(Date.now() - 49 * 60 * 60_000),
          scheduled_shutdown_at: scheduledShutdownAt,
        },
      ],
      stoppedWithBackups: [],
    }));
    shutdownSandbox.mockImplementationOnce(async () => ({
      success: false,
      error: "provider stop failed",
    }));

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://www.elizacloud.ai",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        sandboxesProcessed: 1,
        sandboxesShutdown: 0,
        errors: 1,
        results: [
          {
            action: "error",
            error:
              "Container shutdown failed before credit suspension: provider stop failed",
          },
        ],
      },
    });
    expect(suspendSandboxForInsufficientCredits).not.toHaveBeenCalled();
    expect(webhookFetch).not.toHaveBeenCalled();
  });
});

function expectSignedWebhook(
  init: RequestInit,
  timestamp: string,
  body: string,
) {
  const headers = init.headers as Record<string, string>;
  expect(headers["X-Waifu-Webhook-Signature"]).toBe(
    `sha256=${createHmac("sha256", "test-webhook-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
  );
}
