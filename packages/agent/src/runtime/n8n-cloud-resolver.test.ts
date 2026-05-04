import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __testing, resolveN8nCloudToken } from "./n8n-cloud-resolver.js";

interface MockResponseInit {
  status?: number;
  json?: unknown;
  jsonError?: Error;
  throws?: Error;
}

function mockResponse({
  status = 200,
  json,
  jsonError,
  throws,
}: MockResponseInit): Promise<Response> {
  if (throws) return Promise.reject(throws);
  const body = {
    ok: status >= 200 && status < 300,
    status,
    json: () => (jsonError ? Promise.reject(jsonError) : Promise.resolve(json)),
    text: () =>
      Promise.resolve(typeof json === "string" ? json : JSON.stringify(json)),
  } as unknown as Response;
  return Promise.resolve(body);
}

function makeFetch(responses: MockResponseInit[]): {
  fn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return mockResponse(r);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("resolveN8nCloudToken", () => {
  let stateDir: string;
  let cachePath: string;

  beforeEach(() => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "n8n-cloud-resolver-"));
    cachePath = path.join(stateDir, "n8n", "cloud-token.json");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("normalizeCloudBase strips trailing /api/v1 and slashes", () => {
    expect(
      __testing.normalizeCloudBase("https://www.elizacloud.ai/api/v1"),
    ).toBe("https://www.elizacloud.ai");
    expect(
      __testing.normalizeCloudBase("https://www.elizacloud.ai/api/v1/"),
    ).toBe("https://www.elizacloud.ai");
    expect(__testing.normalizeCloudBase("https://www.elizacloud.ai///")).toBe(
      "https://www.elizacloud.ai",
    );
    expect(__testing.normalizeCloudBase("https://www.elizacloud.ai")).toBe(
      "https://www.elizacloud.ai",
    );
  });

  test("mints a token on first call and caches it mode-0600", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      {
        status: 200,
        json: {
          token: "minted-token-abc",
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        },
      },
    ]);

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved).toEqual({
      host: "https://www.elizacloud.ai/api/v1/n8n",
      apiKey: "minted-token-abc",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://www.elizacloud.ai/api/v1/n8n/tokens");
    const init = calls[0].init as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ELIZA-CLOUD-KEY");
    expect(JSON.parse(init.body as string)).toEqual({
      purpose: "milady-runtime",
    });

    const cached = JSON.parse(await fs.readFile(cachePath, "utf-8")) as {
      token: string;
      expiresAt: string;
      cloudBaseUrl: string;
    };
    expect(cached.token).toBe("minted-token-abc");
    expect(cached.cloudBaseUrl).toBe("https://www.elizacloud.ai");

    const stat = await fs.stat(cachePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("reuses fresh cached token without HTTP call", async () => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        token: "cached-token-xyz",
        expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
        cloudBaseUrl: "https://www.elizacloud.ai",
      }),
      { mode: 0o600 },
    );

    const fetchFn = vi.fn();

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn as unknown as typeof fetch },
    );

    expect(resolved).toEqual({
      host: "https://www.elizacloud.ai/api/v1/n8n",
      apiKey: "cached-token-xyz",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("re-mints when cached token expires within reuse window", async () => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        token: "stale-token",
        // 30s remaining — below 60s reuse window
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        cloudBaseUrl: "https://www.elizacloud.ai",
      }),
    );

    const { fn: fetchFn, calls } = makeFetch([
      {
        status: 200,
        json: {
          token: "fresh-token",
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        },
      },
    ]);

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved?.apiKey).toBe("fresh-token");
    expect(calls).toHaveLength(1);
  });

  test("re-mints when cloudBaseUrl changes", async () => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        token: "old-base-token",
        expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
        cloudBaseUrl: "https://old.elizacloud.ai",
      }),
    );

    const { fn: fetchFn, calls } = makeFetch([
      {
        status: 200,
        json: {
          token: "new-base-token",
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        },
      },
    ]);

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://new.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved?.host).toBe("https://new.elizacloud.ai/api/v1/n8n");
    expect(resolved?.apiKey).toBe("new-base-token");
    expect(calls).toHaveLength(1);
  });

  test("returns null on 404 (gateway not deployed)", async () => {
    const { fn: fetchFn, calls } = makeFetch([{ status: 404 }]);
    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved).toBeNull();
    expect(calls).toHaveLength(1);
    // 404 is non-transient — should not retry.
    await expect(fs.access(cachePath)).rejects.toThrow();
  });

  test("returns null on 401 without retry", async () => {
    const { fn: fetchFn, calls } = makeFetch([{ status: 401 }]);
    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("returns null on 403 without retry", async () => {
    const { fn: fetchFn, calls } = makeFetch([{ status: 403 }]);
    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("retries once on network error then falls through to null", async () => {
    const networkErr = Object.assign(new Error("ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const { fn: fetchFn, calls } = makeFetch([
      { throws: networkErr },
      { throws: networkErr },
    ]);

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("retries once on 5xx and recovers when retry succeeds", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      { status: 502 },
      {
        status: 200,
        json: {
          token: "post-retry-token",
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        },
      },
    ]);

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved?.apiKey).toBe("post-retry-token");
    expect(calls).toHaveLength(2);
  });

  test("returns null on malformed response body", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      { status: 200, json: { foo: "bar" } },
      { status: 200, json: { foo: "bar" } },
    ]);

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test("ignores cache file with wrong shape and re-mints", async () => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "not-json");

    const { fn: fetchFn, calls } = makeFetch([
      {
        status: 200,
        json: {
          token: "regen-token",
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        },
      },
    ]);

    const resolved = await resolveN8nCloudToken(
      "ELIZA-CLOUD-KEY",
      "https://www.elizacloud.ai",
      stateDir,
      { fetch: fetchFn },
    );

    expect(resolved?.apiKey).toBe("regen-token");
    expect(calls).toHaveLength(1);
  });
});
