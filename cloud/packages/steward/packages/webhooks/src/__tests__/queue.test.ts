import { describe, expect, it } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebhookEvent } from "@stwd/shared";
import { WebhookDispatcher } from "../dispatcher";
import { RetryQueue } from "../queue";

const makeEvent = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
  type: "tx_signed",
  tenantId: "test-tenant",
  agentId: "test-agent",
  data: { txHash: "0xabc" },
  timestamp: new Date(),
  ...overrides,
});

type CapturedWebhookRequest = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  bodyText: string;
};

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startWebhookServer(statuses: number[]) {
  const requests: CapturedWebhookRequest[] = [];
  let responseIndex = 0;
  const server = createServer(async (req, res) => {
    const bodyText = await readRequestBody(req);
    requests.push({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: req.headers,
      bodyText,
    });

    const status = statuses[responseIndex] ?? statuses[statuses.length - 1] ?? 200;
    responseIndex += 1;
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(status >= 200 && status < 300 ? "ok" : "error");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    webhook: {
      url: `http://127.0.0.1:${port}/hook`,
      secret: "test-secret",
    },
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe("RetryQueue", () => {
  it("enqueues and delivers a webhook against a real HTTP endpoint", async () => {
    const dispatcher = new WebhookDispatcher({
      maxRetries: 0,
      timeoutMs: 1000,
    });
    const server = await startWebhookServer([200]);

    try {
      const queue = new RetryQueue(dispatcher, {
        maxRetries: 3,
        retryDelayMs: 100,
      });
      const event = makeEvent();

      const id = queue.enqueue(event, server.webhook);
      expect(id).toBeTruthy();
      expect(queue.getStats()).toMatchObject({
        pending: 1,
        delivered: 0,
        failed: 0,
      });

      const results = await queue.processQueue();
      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(true);
      expect(queue.getStats()).toMatchObject({
        pending: 0,
        delivered: 1,
        failed: 0,
      });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.method).toBe("POST");
      expect(server.requests[0]?.path).toBe("/hook");
      expect(server.requests[0]?.headers["x-steward-event"]).toBe("tx_signed");
      expect(server.requests[0]?.headers["x-steward-signature"]).toBeTruthy();
      expect(JSON.parse(server.requests[0]?.bodyText ?? "{}")).toMatchObject({
        tenantId: "test-tenant",
        agentId: "test-agent",
      });
    } finally {
      await server.close();
    }
  });

  it("retries failed deliveries up to maxRetries", async () => {
    const dispatcher = new WebhookDispatcher({ maxRetries: 0, timeoutMs: 100 });
    const server = await startWebhookServer([500, 500]);

    try {
      const queue = new RetryQueue(dispatcher, {
        maxRetries: 2,
        retryDelayMs: 10,
      });
      queue.enqueue(makeEvent(), server.webhook);

      let results = await queue.processQueue();
      expect(results[0]?.success).toBe(false);
      expect(queue.getStats().pending).toBe(1);
      expect(server.requests).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 20));

      results = await queue.processQueue();
      expect(results[0]?.success).toBe(false);
      expect(queue.getStats()).toMatchObject({
        pending: 0,
        delivered: 0,
        failed: 1,
      });
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("does not process deliveries before their retry time", async () => {
    const dispatcher = new WebhookDispatcher({ maxRetries: 0, timeoutMs: 100 });
    const server = await startWebhookServer([500, 500]);

    try {
      const queue = new RetryQueue(dispatcher, {
        maxRetries: 3,
        retryDelayMs: 5_000,
      });
      queue.enqueue(makeEvent(), server.webhook);

      await queue.processQueue();
      expect(queue.getStats().pending).toBe(1);
      expect(server.requests).toHaveLength(1);

      const results = await queue.processQueue();
      expect(results).toHaveLength(0);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("handles multiple enqueued events", async () => {
    const dispatcher = new WebhookDispatcher({
      maxRetries: 0,
      timeoutMs: 1000,
    });
    const server = await startWebhookServer([200, 200, 200]);

    try {
      const queue = new RetryQueue(dispatcher, { maxRetries: 3 });

      queue.enqueue(makeEvent({ agentId: "agent-1" }), server.webhook);
      queue.enqueue(makeEvent({ agentId: "agent-2" }), server.webhook);
      queue.enqueue(makeEvent({ agentId: "agent-3" }), server.webhook);

      expect(queue.getStats().pending).toBe(3);

      const results = await queue.processQueue();
      expect(results).toHaveLength(3);
      expect(results.every((result) => result.success)).toBe(true);
      expect(queue.getStats()).toMatchObject({
        pending: 0,
        delivered: 3,
        failed: 0,
      });
      expect(server.requests).toHaveLength(3);
    } finally {
      await server.close();
    }
  });
});
