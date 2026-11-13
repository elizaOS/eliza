// @vitest-environment jsdom
/**
 * A direct Cloud login binds key release to this browser: the session is
 * created with a verifier hash, the verifier stays in same-origin storage, and
 * only a poll that sends it can claim the key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../client-base";
import { readPendingCloudLogin } from "../client-cloud";

const SESSION_ID = "bbbbbbbb-2222-4333-8444-cccccccccccc";
const BLOCKED_SESSION_ID = "cccccccc-3333-4444-8555-dddddddddddd";
const originalFetch = globalThis.fetch;

function captureCloudRequests(reply: (url: string) => unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(reply(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
});

describe("direct Cloud login verifier", () => {
  it("registers a verifier hash, keeps the verifier, and proves it on the poll", async () => {
    const requests = captureCloudRequests((url) =>
      url.endsWith("/api/auth/cli-session")
        ? {
            sessionId: SESSION_ID,
            status: "pending",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          }
        : { status: "authenticated", apiKey: "eliza_test_key" },
    );
    const client = new ElizaClient("https://api.eliza.app");

    const started = await client.cloudLoginDirect("https://api.eliza.app");
    expect(started.ok).toBe(true);
    expect(started.sessionId).toBe(SESSION_ID);
    const pending = readPendingCloudLogin(SESSION_ID);
    expect(pending).not.toBeNull();
    const created = JSON.parse(String(requests[0]?.init.body));
    expect(created.verifierHash).toBe(await sha256Hex(pending!.verifier));
    expect(JSON.stringify(created)).not.toContain(pending!.verifier);

    const poll = await client.cloudLoginPollDirect(
      "https://api.eliza.app",
      SESSION_ID,
    );
    expect(poll.status).toBe("authenticated");
    expect(
      new Headers(requests[1]?.init.headers).get("X-Cli-Session-Verifier"),
    ).toBe(pending!.verifier);
    // The claim consumes the pending entry.
    expect(readPendingCloudLogin(SESSION_ID)).toBeNull();
  });

  it("still proves the verifier on its own poll when storage is blocked", async () => {
    const requests = captureCloudRequests((url) =>
      url.endsWith("/api/auth/cli-session")
        ? { sessionId: BLOCKED_SESSION_ID, status: "pending" }
        : { status: "pending" },
    );
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const client = new ElizaClient("https://api.eliza.app");
    await client.cloudLoginDirect("https://api.eliza.app");
    await client.cloudLoginPollDirect("https://api.eliza.app", BLOCKED_SESSION_ID);
    setItem.mockRestore();
    const created = JSON.parse(String(requests[0]?.init.body));
    const verifier = new Headers(requests[1]?.init.headers).get(
      "X-Cli-Session-Verifier",
    );
    expect(verifier).toBeTruthy();
    expect(created.verifierHash).toBe(await sha256Hex(String(verifier)));
  });

  it("polls a session it did not start without any verifier", async () => {
    const requests = captureCloudRequests(() => ({ status: "pending" }));
    const client = new ElizaClient("https://api.eliza.app");
    await client.cloudLoginPollDirect("https://api.eliza.app", SESSION_ID);
    expect(
      new Headers(requests[0]?.init.headers).has("X-Cli-Session-Verifier"),
    ).toBe(false);
  });
});
