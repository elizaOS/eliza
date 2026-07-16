/**
 * Fail-closed credential and cleanup contracts for the scheduled Hetzner E2E
 * reaper, using the real client with only its HTTP boundary replaced.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runHetznerE2eReaper } from "./hetzner-e2e-reaper";

let originalFetch: typeof globalThis.fetch;
let responseQueue: Response[];
let requestedMethods: string[];
let requestedUrls: string[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  responseQueue = [];
  requestedMethods = [];
  requestedUrls = [];
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedMethods.push(init?.method ?? "GET");
      requestedUrls.push(String(input));
      const response = responseQueue.shift();
      if (!response) {
        throw new Error("No Hetzner response queued");
      }
      return response;
    },
  ) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Hetzner E2E reaper credential boundary", () => {
  test("intentionally absent credentials remain a no-op", async () => {
    await expect(runHetznerE2eReaper(undefined)).resolves.toBeUndefined();
    expect(requestedMethods).toEqual([]);
    expect(requestedUrls).toEqual([]);
  });

  test("a configured credential rejected by Hetzner fails the sweep", async () => {
    responseQueue.push(
      Response.json(
        { error: { code: "unauthorized", message: "unauthorized" } },
        { status: 401 },
      ),
    );

    await expect(
      runHetznerE2eReaper("rejected-ci-token"),
    ).rejects.toMatchObject({
      name: "HetznerCloudError",
      code: "missing_token",
      status: 401,
    });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain(
      "/servers?label_selector=ci=true,workflow=hetzner-e2e",
    );
  });

  test("a successful empty sweep remains a real success", async () => {
    responseQueue.push(Response.json({ servers: [] }));

    await expect(
      runHetznerE2eReaper("valid-ci-token"),
    ).resolves.toBeUndefined();
    expect(requestedUrls).toHaveLength(1);
  });

  test("deletes a stale server through the real client", async () => {
    responseQueue.push(
      Response.json({
        servers: [
          {
            id: 42,
            name: "ci-hetzner-e2e-stale",
            created: "2000-01-01T00:00:00.000Z",
          },
        ],
      }),
      new Response(null, { status: 204 }),
    );

    await expect(
      runHetznerE2eReaper("valid-ci-token"),
    ).resolves.toBeUndefined();
    expect(requestedMethods).toEqual(["GET", "DELETE"]);
    expect(requestedUrls[1]).toBe("https://api.hetzner.cloud/v1/servers/42");
  });

  test("continues the sweep but fails the process when any deletion fails", async () => {
    responseQueue.push(
      Response.json({
        servers: [
          { id: 42, name: "first", created: "2000-01-01T00:00:00.000Z" },
          { id: 43, name: "second", created: "2000-01-01T00:00:00.000Z" },
        ],
      }),
      Response.json(
        { error: { code: "conflict", message: "server locked" } },
        { status: 409 },
      ),
      new Response(null, { status: 204 }),
    );

    await expect(runHetznerE2eReaper("valid-ci-token")).rejects.toMatchObject({
      name: "AggregateError",
      message: "Hetzner E2E reaper failed to delete 1 stale server(s)",
    });
    expect(requestedMethods).toEqual(["GET", "DELETE", "DELETE"]);
    expect(requestedUrls[2]).toBe("https://api.hetzner.cloud/v1/servers/43");
  });
});
