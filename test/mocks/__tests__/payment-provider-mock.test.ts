import crypto from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startMocks, type StartedMocks } from "../scripts/start-mocks.ts";

let activeMocks: StartedMocks | null = null;
let activeServer: http.Server | null = null;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer?.close((error) => (error ? reject(error) : resolve()));
    });
    activeServer = null;
  }
  if (activeMocks) {
    await activeMocks.stop();
    activeMocks = null;
  }
});

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function jsonRequest(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  return { response, body: await readJson(response) };
}

async function startCallbackServer(): Promise<{
  url: string;
  nextDelivery: Promise<{
    headers: http.IncomingHttpHeaders;
    rawBody: string;
    body: Record<string, unknown>;
  }>;
}> {
  let resolveDelivery:
    | ((value: {
        headers: http.IncomingHttpHeaders;
        rawBody: string;
        body: Record<string, unknown>;
      }) => void)
    | null = null;
  const nextDelivery = new Promise<{
    headers: http.IncomingHttpHeaders;
    rawBody: string;
    body: Record<string, unknown>;
  }>((resolve) => {
    resolveDelivery = resolve;
  });

  activeServer = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    resolveDelivery?.({
      headers: req.headers,
      rawBody,
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });
    res.writeHead(204);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    activeServer?.once("error", reject);
    activeServer?.listen(0, "127.0.0.1", () => resolve());
  });

  const address = activeServer.address();
  if (!address || typeof address === "string") {
    throw new Error("callback server did not bind a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/callback`,
    nextDelivery,
  };
}

function paymentRequest(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.paymentRequest;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("paymentRequest missing from response");
  }
  return value as Record<string, unknown>;
}

describe("payments mock provider", () => {
  it("creates a $1 payment request, marks it paid, and exposes ledger state", async () => {
    activeMocks = await startMocks({ envs: ["payments"] });
    const baseUrl = activeMocks.baseUrls.payments;

    const created = await jsonRequest(`${baseUrl}/v1/payment-requests`, {
      method: "POST",
      body: JSON.stringify({
        amountUsd: 1,
        description: "WooBench one dollar charge",
        metadata: { benchmark: "woobench" },
      }),
    });
    expect(created.response.status).toBe(201);
    const createdRequest = paymentRequest(created.body);
    expect(createdRequest.amountUsd).toBe(1);
    expect(createdRequest.status).toBe("requested");
    expect(createdRequest.callbackSecretSet).toBe(false);

    const paid = await jsonRequest(
      `${baseUrl}/v1/payment-requests/${createdRequest.id}/pay`,
      { method: "POST", body: JSON.stringify({ transactionHash: "mock_tx_1" }) },
    );
    expect(paid.response.status).toBe(200);
    expect(paid.body.accepted).toBe(true);
    expect(paymentRequest(paid.body).status).toBe("paid");
    expect(paymentRequest(paid.body).transactionHash).toBe("mock_tx_1");

    const status = await jsonRequest(`${baseUrl}/v1/payment-requests/${createdRequest.id}`);
    expect(status.response.status).toBe(200);
    expect(paymentRequest(status.body).paid).toBe(true);

    const ledger = await jsonRequest(`${baseUrl}/__mock/payments/requests`);
    const paymentRequests = ledger.body.paymentRequests as Array<Record<string, unknown>>;
    expect(paymentRequests).toHaveLength(1);
    expect(paymentRequests[0]?.status).toBe("paid");

    const requestActions = activeMocks
      .requestLedger()
      .map((entry) => entry.payment?.action)
      .filter(Boolean);
    expect(requestActions).toContain("payment_requests.create");
    expect(requestActions).toContain("payment_requests.pay");
  });

  it("delivers signed paid callbacks", async () => {
    activeMocks = await startMocks({ envs: ["payments"] });
    const baseUrl = activeMocks.baseUrls.payments;
    const callback = await startCallbackServer();
    const secret = "mock-payment-callback-secret";

    const created = await jsonRequest(`${baseUrl}/v1/payment-requests`, {
      method: "POST",
      body: JSON.stringify({
        amountUsd: 1,
        callbackUrl: callback.url,
        callbackSecret: secret,
        channel: { source: "woobench", roomId: "room-1", agentId: "agent-1" },
      }),
    });
    const id = paymentRequest(created.body).id;

    await jsonRequest(`${baseUrl}/v1/payment-requests/${id}/pay`, {
      method: "POST",
      body: JSON.stringify({ transactionHash: "mock_tx_callback" }),
    });

    const delivery = await Promise.race([
      callback.nextDelivery,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("callback delivery timed out")), 2_000),
      ),
    ]);
    expect(delivery.headers["x-eliza-event"]).toBe("payment_request.paid");
    expect(delivery.body.event).toBe("payment_request.paid");
    const timestamp = String(delivery.headers["x-eliza-timestamp"]);
    const expectedSignature = `sha256=${crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}.${delivery.rawBody}`)
      .digest("hex")}`;
    expect(delivery.headers["x-eliza-signature"]).toBe(expectedSignature);

    const ledger = await jsonRequest(`${baseUrl}/__mock/payments/requests`);
    const callbacks = ledger.body.callbacks as Array<Record<string, unknown>>;
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.delivered).toBe(true);
    expect(callbacks[0]?.statusCode).toBe(204);
  });
});
