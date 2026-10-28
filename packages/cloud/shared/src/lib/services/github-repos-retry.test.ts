import { afterEach, beforeEach, expect, mock, test } from "bun:test";

/**
 * GitHub answers a secondary rate limit with 429, or 403, plus a
 * `retry-after` or `x-ratelimit-reset` header that states how long to wait;
 * a 5xx after `createUsingTemplate` may follow a repository that was created.
 * The Octokit instance is replaced by a scripted stub.
 */
process.env.GITHUB_APP_TOKEN = "token";

type Script = Array<() => Promise<unknown>>;
const scripts: Record<string, Script> = {};
const calls: Record<string, number> = {};

function scripted(name: string) {
  return async () => {
    calls[name] = (calls[name] ?? 0) + 1;
    const step = scripts[name]?.shift();
    if (!step) throw new Error(`no scripted answer for ${name}`);
    return step();
  };
}

mock.module("@octokit/rest", () => ({
  Octokit: class {
    repos = {
      get: scripted("get"),
      createUsingTemplate: scripted("createUsingTemplate"),
      listCommits: scripted("listCommits"),
      delete: scripted("delete"),
    };
  },
}));

const { createAppRepo, getRepoInfo, withRetry } = await import("./github-repos");

function requestError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });
}

const repoData = {
  name: "app-1",
  full_name: "eliza-cloud-apps/app-1",
  html_url: "https://github.com/eliza-cloud-apps/app-1",
  clone_url: "https://github.com/eliza-cloud-apps/app-1.git",
  ssh_url: "git@github.com:eliza-cloud-apps/app-1.git",
  default_branch: "main",
  private: true,
  created_at: "2026-10-13T00:00:00Z",
};

beforeEach(() => {
  for (const key of Object.keys(scripts)) delete scripts[key];
  for (const key of Object.keys(calls)) delete calls[key];
});

afterEach(() => {
  mock.restore();
});

const sleeps: number[] = [];
const deps = {
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
  random: () => 1,
};

test("a 429 waits the seconds GitHub states and then succeeds", async () => {
  sleeps.length = 0;
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw requestError(429, { "retry-after": "7" });
      return "ok";
    },
    "test",
    {},
    deps,
  );
  expect(result).toBe("ok");
  expect(sleeps).toEqual([7_000]);
});

test("a 403 with a reset time waits until the reset; one without a wait is not retried", async () => {
  sleeps.length = 0;
  const resetAt = Math.floor(Date.now() / 1000) + 42;
  let attempts = 0;
  await withRetry(
    async () => {
      attempts += 1;
      if (attempts === 1)
        throw requestError(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        });
      return "ok";
    },
    "test",
    {},
    deps,
  );
  expect(sleeps[0]).toBeGreaterThanOrEqual(41_000);
  expect(sleeps[0]).toBeLessThanOrEqual(42_000);

  sleeps.length = 0;
  let denied = 0;
  await expect(
    withRetry(
      async () => {
        denied += 1;
        throw requestError(403);
      },
      "test",
      {},
      deps,
    ),
  ).rejects.toThrow("HTTP 403");
  expect(denied).toBe(1);
  expect(sleeps).toEqual([]);
});

test("a stated wait above the bound is not shortened: the call is not retried", async () => {
  sleeps.length = 0;
  let attempts = 0;
  await expect(
    withRetry(
      async () => {
        attempts++;
        throw requestError(429, { "retry-after": "120" });
      },
      "bounded",
      {},
      deps,
    ),
  ).rejects.toMatchObject({ status: 429, response: { headers: { "retry-after": "120" } } });
  expect(attempts).toBe(1);
  expect(sleeps).toEqual([]);
});

test("a reset time above the bound is not shortened either", async () => {
  sleeps.length = 0;
  let attempts = 0;
  const resetAt = Math.floor(Date.now() / 1000) + 600;
  await expect(
    withRetry(
      async () => {
        attempts++;
        throw requestError(403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(resetAt),
        });
      },
      "bounded-reset",
      {},
      deps,
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(attempts).toBe(1);
  expect(sleeps).toEqual([]);
});

test("getRepoInfo retries a 429 through the real Octokit path", async () => {
  scripts.get = [
    async () => {
      throw requestError(429, { "retry-after": "0" });
    },
    async () => ({ data: repoData }),
  ];
  const info = await getRepoInfo("app-1");
  expect(info?.fullName).toBe("eliza-cloud-apps/app-1");
  expect(calls.get).toBe(2);
});

test("createAppRepo sends createUsingTemplate once when the outcome is unknown", async () => {
  scripts.createUsingTemplate = [
    async () => {
      throw requestError(502);
    },
    async () => {
      throw requestError(422, {}); // "name already exists": the first call created it
    },
  ];
  await expect(createAppRepo({ name: "app-1" })).rejects.toThrow("HTTP 502");
  expect(calls.createUsingTemplate).toBe(1);
});
