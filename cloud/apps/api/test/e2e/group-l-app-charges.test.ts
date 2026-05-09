import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, bearerHeaders, getBaseUrl, isServerReachable } from "./_helpers/api";

let serverReachable = false;
let hasTestApiKey = false;
const createdAppIds: string[] = [];

function shouldRunAuthed(): boolean {
  return serverReachable && hasTestApiKey;
}

async function createTestApp(): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await api.post(
    "/api/v1/apps",
    {
      name: `Dollar Charge ${suffix}`,
      description: "One dollar app charge regression test",
      app_url: "https://example.com/app",
      website_url: "https://example.com",
      allowed_origins: ["https://example.com"],
      skipGitHubRepo: true,
    },
    { headers: bearerHeaders() },
  );

  expect(res.status).toBe(200);
  const body = (await res.json()) as { app?: { id?: string } };
  expect(body.app?.id).toBeTruthy();
  createdAppIds.push(body.app?.id as string);
  return body.app?.id as string;
}

beforeAll(async () => {
  hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-l-app-charges] ${getBaseUrl()} did not respond to /api/health. Tests will skip.`,
    );
    return;
  }
  if (!hasTestApiKey) {
    console.warn("[group-l-app-charges] TEST_API_KEY is not set; auth-required tests will skip.");
  }
});

afterAll(async () => {
  if (!shouldRunAuthed()) return;
  for (const appId of createdAppIds) {
    await api.delete(`/api/v1/apps/${appId}?deleteGitHubRepo=false`, {
      headers: bearerHeaders(),
    });
  }
});

describe("App charge requests", () => {
  test("auth gate: rejects one dollar charge creation without credentials", async () => {
    if (!serverReachable) return;
    const res = await api.post("/api/v1/apps/00000000-0000-4000-8000-000000000000/charges", {
      amount: 1,
    });
    expect(res.status).toBe(401);
  });

  test("happy path: creates a one dollar card/crypto charge with callback metadata", async () => {
    if (!shouldRunAuthed()) return;
    const appId = await createTestApp();

    const res = await api.post(
      `/api/v1/apps/${appId}/charges`,
      {
        amount: 1,
        description: "Test $1 payment request",
        providers: ["stripe", "oxapay"],
        callback_url: "https://example.com/payment-callback",
        callback_secret: "test-callback-secret",
        callback_channel: {
          source: "cloud",
          roomId: "00000000-0000-4000-8000-000000000001",
          agentId: "00000000-0000-4000-8000-000000000002",
        },
        callback_metadata: {
          initiatedBy: "group-l-app-charges",
        },
      },
      { headers: bearerHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      charge?: {
        id?: string;
        appId?: string;
        amountUsd?: number;
        paymentUrl?: string;
        status?: string;
        providers?: string[];
        metadata?: Record<string, unknown>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.charge?.appId).toBe(appId);
    expect(body.charge?.amountUsd).toBe(1);
    expect(body.charge?.status).toBe("requested");
    expect(body.charge?.providers).toEqual(["stripe", "oxapay"]);
    expect(body.charge?.paymentUrl).toContain(`/payment/app-charge/${appId}/`);
    expect(body.charge?.metadata?.callback_secret).toBeUndefined();
    expect(body.charge?.metadata?.callback_secret_set).toBe(true);

    const publicRes = await api.get(`/api/v1/apps/${appId}/charges/${body.charge?.id}`);
    expect(publicRes.status).toBe(200);
    const publicBody = (await publicRes.json()) as {
      charge?: { amountUsd?: number; metadata?: Record<string, unknown> };
    };
    expect(publicBody.charge?.amountUsd).toBe(1);
    expect(publicBody.charge?.metadata?.callback_secret).toBeUndefined();
  });

  test("validation: rejects charges below one dollar", async () => {
    if (!shouldRunAuthed()) return;
    const appId = await createTestApp();
    const res = await api.post(
      `/api/v1/apps/${appId}/charges`,
      { amount: 0.99 },
      { headers: bearerHeaders() },
    );

    expect(res.status).toBe(400);
  });
});
