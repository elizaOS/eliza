/**
 * Verifies the stability-attempt parent fetch boundary with keyless local
 * transports and selected-provider rejection fixtures.
 */

import { describe, expect, test } from "bun:test";
import {
  createLoopbackOnlyFetch,
  type StabilityParentNetworkEntry,
} from "./parent-network-guard.ts";

describe("stability parent network guard", () => {
  test("admits loopback and retains the request decision", async () => {
    const ledger: StabilityParentNetworkEntry[] = [];
    const calls: string[] = [];
    const nativeFetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        calls.push(String(input));
        return Response.json({ ok: true });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
    const guardedFetch = createLoopbackOnlyFetch(nativeFetch, ledger);

    expect(
      (await guardedFetch("http://127.0.0.1:43123/health", { method: "POST" }))
        .ok,
    ).toBe(true);
    expect(calls).toEqual(["http://127.0.0.1:43123/health"]);
    expect(ledger).toEqual([
      {
        origin: "http://127.0.0.1:43123",
        method: "POST",
        allowed: true,
      },
    ]);
  });

  test.each([
    "https://api.openai.com/v1/responses",
    "https://api.anthropic.com/v1/messages",
  ])(
    "rejects direct selected-provider origin and retains denial: %s",
    async (url) => {
      const ledger: StabilityParentNetworkEntry[] = [];
      let nativeCalls = 0;
      const nativeFetch = Object.assign(
        async () => {
          nativeCalls += 1;
          return Response.json({});
        },
        { preconnect: fetch.preconnect },
      ) as typeof fetch;
      const guardedFetch = createLoopbackOnlyFetch(nativeFetch, ledger);

      await expect(guardedFetch(url)).rejects.toThrow(
        "unexpected egress blocked",
      );
      expect(nativeCalls).toBe(0);
      expect(ledger).toEqual([
        { origin: new URL(url).origin, method: "GET", allowed: false },
      ]);
    },
  );

  test("rejects a hostname that merely starts with the IPv4 loopback prefix", async () => {
    const ledger: StabilityParentNetworkEntry[] = [];
    let nativeCalls = 0;
    const nativeFetch = Object.assign(
      async () => {
        nativeCalls += 1;
        return Response.json({});
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
    const guardedFetch = createLoopbackOnlyFetch(nativeFetch, ledger);

    await expect(
      guardedFetch("http://127.attacker.invalid/provider"),
    ).rejects.toThrow("unexpected egress blocked");
    expect(nativeCalls).toBe(0);
    expect(ledger).toEqual([
      {
        origin: "http://127.attacker.invalid",
        method: "GET",
        allowed: false,
      },
    ]);
  });

  test("rejects and retains a loopback redirect to a remote origin", async () => {
    const ledger: StabilityParentNetworkEntry[] = [];
    const nativeCalls: string[] = [];
    const nativeFetch = Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        nativeCalls.push(String(input));
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://api.openai.com/v1/responses" },
        });
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch;
    const guardedFetch = createLoopbackOnlyFetch(nativeFetch, ledger);

    await expect(
      guardedFetch("http://127.0.0.1:43123/redirect"),
    ).rejects.toThrow("unexpected redirect egress blocked");
    expect(nativeCalls).toEqual(["http://127.0.0.1:43123/redirect"]);
    expect(ledger).toEqual([
      {
        origin: "http://127.0.0.1:43123",
        method: "GET",
        allowed: true,
      },
      {
        origin: "https://api.openai.com",
        method: "GET",
        allowed: false,
      },
    ]);
  });
});
