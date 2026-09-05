/**
 * Unit coverage for the OWNER-only consumer-key admin verbs that
 * client-agent-consumer-keys installs on ElizaClient: list / create / update /
 * rotate against /api/accounts/consumer-keys*, including response-shape
 * validation (a malformed agent reply must throw instead of rendering
 * undefined fields) and the one-time plaintext-key contract. Transport stubbed
 * via ElizaClient.fetch; no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import { CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS } from "./client-agent-consumer-keys";
import { ElizaClient } from "./client-base";

function clientWithBody(body: unknown): {
  client: ElizaClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const client = new ElizaClient("http://agent.example:31337", "token");
  const fetchMock = vi.fn(async () => body);
  client.fetch = fetchMock as unknown as typeof client.fetch;
  return { client, fetchMock };
}

function validSummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "ck-1",
    label: "CI pool",
    enabled: true,
    dailyTokenQuota: 1000,
    keyPrefix: "ck_live_ab12",
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe("CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS", () => {
  it("keeps the documented independent-hop 10s REST budget", () => {
    expect(CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});

describe("ElizaClient.listConsumerKeys", () => {
  it("GETs the pool with the default 10s budget and parses every summary", async () => {
    const summary = validSummary({ lastUsedAt: 300 });
    const { client, fetchMock } = clientWithBody({ keys: [summary] });
    const result = await client.listConsumerKeys();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/consumer-keys",
      { signal: undefined },
      { timeoutMs: CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS },
    );
    expect(result).toEqual([summary]);
  });

  it("forwards a caller-supplied timeoutMs instead of the default", async () => {
    const { client, fetchMock } = clientWithBody({ keys: [] });
    await client.listConsumerKeys(1234);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/consumer-keys",
      { signal: undefined },
      { timeoutMs: 1234 },
    );
  });

  it("forwards a caller cancellation signal without changing the timeout", async () => {
    const { client, fetchMock } = clientWithBody({ keys: [] });
    const controller = new AbortController();
    await client.listConsumerKeys(undefined, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/accounts/consumer-keys",
      { signal: controller.signal },
      { timeoutMs: CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("omits lastUsedAt for a key that was never used", async () => {
    const { client } = clientWithBody({ keys: [validSummary()] });
    const [result] = await client.listConsumerKeys();
    expect(result).not.toHaveProperty("lastUsedAt");
  });

  it("accepts a null dailyTokenQuota as an unbounded key", async () => {
    const { client } = clientWithBody({
      keys: [validSummary({ dailyTokenQuota: null })],
    });
    await expect(client.listConsumerKeys()).resolves.toEqual([
      validSummary({ dailyTokenQuota: null }),
    ]);
  });

  it("rejects a non-record reply such as null or an array", async () => {
    for (const body of [null, [validSummary()]]) {
      const { client } = clientWithBody(body);
      await expect(client.listConsumerKeys()).rejects.toThrow(
        "Malformed consumer-key list from agent",
      );
    }
  });

  it("rejects a reply whose keys field is not an array", async () => {
    const { client } = clientWithBody({ keys: validSummary() });
    await expect(client.listConsumerKeys()).rejects.toThrow(
      "Malformed consumer-key list from agent",
    );
  });

  it("rejects an element whose required fields are mistyped", async () => {
    const { client } = clientWithBody({
      keys: [validSummary({ enabled: "yes" })],
    });
    await expect(client.listConsumerKeys()).rejects.toThrow(
      "Malformed consumer-key record from agent",
    );
  });

  it("rejects a dailyTokenQuota that is neither null nor a number", async () => {
    const { client } = clientWithBody({
      keys: [validSummary({ dailyTokenQuota: "1000" })],
    });
    await expect(client.listConsumerKeys()).rejects.toThrow(
      "Malformed consumer-key record from agent",
    );
  });

  it("drops a non-numeric lastUsedAt rather than rejecting the record", async () => {
    // Observed behaviour: only a numeric lastUsedAt is spread into the
    // summary, so a mistyped one is silently omitted instead of failing.
    const { client } = clientWithBody({
      keys: [validSummary({ lastUsedAt: "300" })],
    });
    const [result] = await client.listConsumerKeys();
    expect(result).not.toHaveProperty("lastUsedAt");
    expect(result).toMatchObject(validSummary());
  });
});

describe("ElizaClient.createConsumerKey", () => {
  it("POSTs the patch body and returns the one-time key plus consumer", async () => {
    const summary = validSummary();
    const { client, fetchMock } = clientWithBody({
      key: "ck_live_new_secret",
      consumer: summary,
    });
    const result = await client.createConsumerKey({ label: "nightly" });
    expect(fetchMock).toHaveBeenCalledWith("/api/accounts/consumer-keys", {
      method: "POST",
      body: JSON.stringify({ label: "nightly" }),
    });
    expect(result).toEqual({
      key: "ck_live_new_secret",
      consumer: summary,
    });
  });

  it("rejects an empty plaintext key", async () => {
    const { client } = clientWithBody({
      key: "",
      consumer: validSummary(),
    });
    await expect(client.createConsumerKey({})).rejects.toThrow(
      "Malformed consumer-key create/rotate response",
    );
  });

  it("rejects a non-string plaintext key", async () => {
    const { client } = clientWithBody({
      key: 42,
      consumer: validSummary(),
    });
    await expect(client.createConsumerKey({})).rejects.toThrow(
      "Malformed consumer-key create/rotate response",
    );
  });

  it("rejects a consumer payload that fails summary validation", async () => {
    const { client } = clientWithBody({
      key: "ck_live_new_secret",
      consumer: validSummary({ createdAt: "100" }),
    });
    await expect(client.createConsumerKey({})).rejects.toThrow(
      "Malformed consumer-key record from agent",
    );
  });
});

describe("ElizaClient.updateConsumerKey", () => {
  it("PATCHes the percent-encoded path and returns the updated summary", async () => {
    const id = "ck/1 x";
    const summary = validSummary({ id });
    const { client, fetchMock } = clientWithBody({ consumer: summary });
    const result = await client.updateConsumerKey(id, { enabled: false });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/accounts/consumer-keys/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(result).toEqual(summary);
  });

  it("rejects a non-record update reply", async () => {
    const { client } = clientWithBody(null);
    await expect(
      client.updateConsumerKey("ck-1", { enabled: false }),
    ).rejects.toThrow("Malformed consumer-key update response");
  });

  it("rejects a consumer field that fails summary validation", async () => {
    const { client } = clientWithBody({
      consumer: validSummary({ keyPrefix: 7 }),
    });
    await expect(
      client.updateConsumerKey("ck-1", { label: "renamed" }),
    ).rejects.toThrow("Malformed consumer-key record from agent");
  });
});

describe("ElizaClient.rotateConsumerKey", () => {
  it("POSTs to the rotate endpoint and returns the replacement key", async () => {
    const id = "ck 9";
    const summary = validSummary({ id });
    const { client, fetchMock } = clientWithBody({
      key: "ck_live_rotated",
      consumer: summary,
    });
    const result = await client.rotateConsumerKey(id);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/accounts/consumer-keys/${encodeURIComponent(id)}/rotate`,
      { method: "POST" },
    );
    expect(result).toEqual({ key: "ck_live_rotated", consumer: summary });
  });

  it("rejects a malformed rotate reply", async () => {
    const { client } = clientWithBody({ consumer: validSummary() });
    await expect(client.rotateConsumerKey("ck-1")).rejects.toThrow(
      "Malformed consumer-key create/rotate response",
    );
  });
});
