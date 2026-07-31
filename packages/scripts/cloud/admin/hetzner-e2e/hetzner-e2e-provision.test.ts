/**
 * Provisioning cleanup, quota, and diagnostics contracts exercised through
 * the real Hetzner client with only its HTTP boundary replaced.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHetznerE2eProvision } from "./hetzner-e2e-provision";

type RecordedRequest = {
  method: string;
  url: string;
  body: unknown;
};

let originalFetch: typeof globalThis.fetch;
let originalConsoleError: typeof console.error;
let responseQueue: Response[];
let requests: RecordedRequest[];
let errorLogs: string[];
let originalEnv: Record<string, string | undefined>;
const stateFile = join(
  tmpdir(),
  `hetzner-e2e-provision-http-${process.pid}.json`,
);
const testEnv = {
  HCLOUD_TOKEN_CI: "valid-ci-token",
  CI_SSH_PUBLIC_KEY_ID: "123",
  GITHUB_RUN_ID: "test-run",
  HETZNER_E2E_LOCATION: "nbg1",
  HETZNER_E2E_SERVER_TYPE: "cpx22",
  HETZNER_E2E_STATE_FILE: stateFile,
} as const;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function server(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 42,
    name: "ci-hetzner-e2e-server",
    status: "running",
    created: "2000-01-01T00:00:00.000Z",
    public_net: {
      ipv4: { ip: "203.0.113.10", blocked: false },
      ipv6: null,
    },
    server_type: { id: 1, name: "cpx22" },
    datacenter: {
      id: 1,
      name: "nbg1-dc3",
      location: { id: 1, name: "nbg1", city: "Nuremberg", country: "DE" },
    },
    labels: { ci: "true", workflow: "hetzner-e2e" },
    ...overrides,
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalConsoleError = console.error;
  responseQueue = [];
  requests = [];
  errorLogs = [];
  originalEnv = Object.fromEntries(
    Object.keys(testEnv).map((name) => [name, process.env[name]]),
  );
  for (const [name, value] of Object.entries(testEnv)) {
    setEnv(name, value);
  }

  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const response = responseQueue.shift();
      if (!response) {
        throw new Error("No Hetzner response queued");
      }
      return response;
    },
  ) as unknown as typeof globalThis.fetch;
  console.error = mock((...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  for (const [name, value] of Object.entries(originalEnv)) {
    setEnv(name, value);
  }
  if (existsSync(stateFile)) {
    rmSync(stateFile);
  }
});

describe("Hetzner E2E provision HTTP boundary", () => {
  test("reaps only stale servers returned by the CI label selector", async () => {
    responseQueue.push(
      Response.json({
        servers: [
          server(),
          server({
            id: 43,
            name: "recent",
            created: new Date().toISOString(),
          }),
        ],
      }),
      new Response(null, { status: 204 }),
      Response.json({
        server: server({ id: 99, created: new Date().toISOString() }),
        root_password: null,
      }),
    );

    await expect(runHetznerE2eProvision()).resolves.toMatchObject({ id: 99 });
    const persistedState = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(persistedState).toMatchObject({
      server_id: 99,
    });
    expect(persistedState).not.toHaveProperty("id");

    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.hetzner.cloud/v1/servers?label_selector=ci=true,workflow=hetzner-e2e",
    });
    expect(requests.filter((request) => request.method === "DELETE")).toEqual([
      {
        method: "DELETE",
        url: "https://api.hetzner.cloud/v1/servers/42",
        body: undefined,
      },
    ]);
  });

  test("fails before create when the labeled inventory cannot be read", async () => {
    responseQueue.push(
      Response.json(
        { error: { code: "server_error", message: "inventory unavailable" } },
        { status: 500 },
      ),
    );

    await expect(runHetznerE2eProvision()).rejects.toMatchObject({
      code: "server_error",
      status: 500,
    });
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });

  test("fails before create when reaping a stale labeled server fails", async () => {
    responseQueue.push(
      Response.json({ servers: [server()] }),
      Response.json(
        { error: { code: "conflict", message: "server locked" } },
        { status: 409 },
      ),
    );

    await expect(runHetznerE2eProvision()).rejects.toMatchObject({
      code: "server_error",
      status: 409,
    });
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "DELETE",
    ]);
  });

  test("limit_reached stops location retries and logs only sanitized capacity", async () => {
    responseQueue.push(
      Response.json({ servers: [] }),
      Response.json(
        { error: { code: "limit_reached", message: "server limit reached" } },
        { status: 403 },
      ),
      Response.json({
        servers: [
          server({
            id: 700,
            name: "private-production-name",
            public_net: {
              ipv4: { ip: "198.51.100.77", blocked: false },
              ipv6: null,
            },
            labels: { owner: "secret-owner" },
          }),
          server({ id: 701 }),
        ],
      }),
    );

    await expect(runHetznerE2eProvision()).rejects.toMatchObject({
      message: expect.stringContaining("project quota exhausted"),
      name: "HetznerCloudError",
      code: "quota_exceeded",
      status: 403,
      cause: { code: "quota_exceeded" },
    });

    const createRequests = requests.filter(
      (request) =>
        request.method === "POST" && request.url.endsWith("/servers"),
    );
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]?.body).toMatchObject({
      server_type: "cpx22",
      location: "nbg1",
    });
    expect(requests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://api.hetzner.cloud/v1/servers",
    });

    const capacityLog = errorLogs.find((line) =>
      line.includes("project capacity inventory"),
    );
    expect(capacityLog).toContain('"totalServers":2');
    expect(capacityLog).toContain('"hetznerE2eServers":1');
    expect(capacityLog).not.toContain("private-production-name");
    expect(capacityLog).not.toContain("198.51.100.77");
    expect(capacityLog).not.toContain("secret-owner");
    expect(capacityLog).not.toContain('"id":');
  });
});
