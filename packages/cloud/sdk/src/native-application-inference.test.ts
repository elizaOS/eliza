/** Exercises actual SDK request dispatch, stable native operation retries and prepaid compatibility over local HTTP. */
import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

test("selected native inference sends only purchaser identity and a stable operation while ordinary calls remain prepaid", async () => {
  const requests: Array<{ headers: Headers; body: string; path: string }> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({
        headers: request.headers,
        body: await request.text(),
        path: new URL(request.url).pathname,
      });
      return Response.json({ choices: [] });
    },
  });
  try {
    const options = {
      baseUrl: server.url.toString(),
      apiBaseUrl: new URL("/api/v1", server.url).toString(),
      apiKey: "eliza_native_buyer",
    };
    const native = new ElizaCloudClient({
      ...options,
      nativeApplicationSlot: "eliza-app",
    });
    const operation = {
      json: {
        model: "model-a",
        messages: [{ role: "user", content: "complete input" }],
      },
      headers: { "Idempotency-Key": "native:stable-operation" },
    };
    await native.v1.requestRaw("POST", "/chat/completions", operation);
    await native.v1.requestRaw("POST", "/chat/completions", operation);
    expect(requests[0]?.headers.get("X-Eliza-Application-Slot")).toBe(
      "eliza-app",
    );
    expect(requests[0]?.headers.get("Authorization")).toBe(
      "Bearer eliza_native_buyer",
    );
    expect(requests[1]?.headers.get("Idempotency-Key")).toBe(
      requests[0]?.headers.get("Idempotency-Key"),
    );
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(requests[0]?.headers.has("X-Eliza-Developer-Authorization")).toBe(
      false,
    );
    await new ElizaCloudClient(options).v1.requestRaw(
      "POST",
      "/chat/completions",
      { json: operation.json },
    );
    expect(requests[2]?.headers.has("X-Eliza-Application-Slot")).toBe(false);
    expect(requests[2]?.headers.has("Idempotency-Key")).toBe(false);
    await native.v1.get("/models");
    expect(requests[3]?.headers.has("X-Eliza-Application-Slot")).toBe(false);
    await expect(
      native.v1.requestRaw("POST", "/responses", {
        json: { input: "full input" },
      }),
    ).rejects.toThrow("Persist an operation ID");
    await expect(
      native.v1.post("/voice/tts", { text: "hello" }),
    ).rejects.toThrow("does not support");
    await expect(
      native.v1.requestRaw("POST", "/embeddings", {
        ...operation,
        headers: { ...operation.headers, "X-App-Id": "legacy" },
      }),
    ).rejects.toThrow("cannot be combined");
    await expect(
      native.v1.requestRaw("POST", "/responses", {
        ...operation,
        headers: {
          ...operation.headers,
          "X-Eliza-Application-Slot": "other-product",
        },
      }),
    ).rejects.toThrow("different application product");
    expect(requests).toHaveLength(4);
  } finally {
    server.stop(true);
  }
});
