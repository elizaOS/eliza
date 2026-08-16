/**
 * Exercises the names-only Worker-secret removal boundary with an injected
 * Wrangler runner, including already-absent, verified deletion, and failures.
 */

import { describe, expect, test } from "bun:test";
import {
  ensureWorkerSecretAbsent,
  parseWorkerSecretNames,
  validateWranglerEnvironmentArgs,
} from "../ensure-worker-secret-absent.mjs";

describe("ensureWorkerSecretAbsent", () => {
  test("accepts an already-absent binding without issuing a delete", async () => {
    const calls: string[][] = [];
    const result = await ensureWorkerSecretAbsent({
      name: "STAGING_SESSION_EXCHANGE_ENABLED",
      wranglerArgs: ["--env", "staging"],
      run: async (args: string[]) => {
        calls.push(args);
        return JSON.stringify([
          { name: "OTHER_SECRET", type: "secret_text" },
          { name: "mixedCaseSecret", type: "secret_text" },
        ]);
      },
      sleep: async () => {},
    });

    expect(result).toBe("already-absent");
    expect(calls).toEqual([
      ["secret", "list", "--env", "staging", "--format", "json"],
    ]);
  });

  test("deletes a present binding and verifies the names-only inventory", async () => {
    const calls: string[][] = [];
    const outputs = [
      JSON.stringify([
        { name: "STAGING_SESSION_EXCHANGE_ENABLED", type: "secret_text" },
      ]),
      "",
      "[]",
    ];
    const result = await ensureWorkerSecretAbsent({
      name: "STAGING_SESSION_EXCHANGE_ENABLED",
      wranglerArgs: ["--env", "staging"],
      run: async (args: string[]) => {
        calls.push(args);
        return outputs.shift() ?? "[]";
      },
      sleep: async () => {},
    });

    expect(result).toBe("removed");
    expect(calls).toEqual([
      ["secret", "list", "--env", "staging", "--format", "json"],
      [
        "secret",
        "delete",
        "STAGING_SESSION_EXCHANGE_ENABLED",
        "--env",
        "staging",
      ],
      ["secret", "list", "--env", "staging", "--format", "json"],
    ]);
  });

  test("uses version-aware inventory and deletion before a code deploy", async () => {
    const calls: string[][] = [];
    const outputs = [
      JSON.stringify([
        { id: "older", number: 8 },
        { id: "before", number: 10 },
        { id: "oldest", number: 3 },
      ]),
      JSON.stringify({
        resources: {
          bindings: [
            { name: "STAGING_SESSION_EXCHANGE_ENABLED", type: "secret_text" },
            { name: "PLAIN_VALUE", type: "plain_text" },
          ],
        },
      }),
      "",
      JSON.stringify([{ id: "after", number: 11 }]),
      JSON.stringify({ resources: { bindings: [] } }),
    ];
    const result = await ensureWorkerSecretAbsent({
      name: "STAGING_SESSION_EXCHANGE_ENABLED",
      wranglerArgs: ["--env", "staging"],
      versioned: true,
      run: async (args: string[]) => {
        calls.push(args);
        return outputs.shift() ?? "[]";
      },
      sleep: async () => {},
    });

    expect(result).toBe("removed");
    expect(calls).toEqual([
      ["versions", "list", "--env", "staging", "--json"],
      ["versions", "view", "before", "--env", "staging", "--json"],
      [
        "versions",
        "secret",
        "delete",
        "STAGING_SESSION_EXCHANGE_ENABLED",
        "--env",
        "staging",
      ],
      ["versions", "list", "--env", "staging", "--json"],
      ["versions", "view", "after", "--env", "staging", "--json"],
    ]);
  });

  test("fails closed when the latest version inventory is malformed", async () => {
    await expect(
      ensureWorkerSecretAbsent({
        name: "STAGING_SESSION_EXCHANGE_ENABLED",
        versioned: true,
        attempts: 1,
        run: async () => JSON.stringify([]),
        sleep: async () => {},
      }),
    ).rejects.toThrow("Could not confirm Worker secret");
  });

  test("owns an ambiguous delete when the retry proves absence", async () => {
    const calls: string[][] = [];
    const result = await ensureWorkerSecretAbsent({
      name: "STAGING_SESSION_EXCHANGE_ENABLED",
      attempts: 2,
      retryDelayMs: 0,
      run: async (args: string[]) => {
        calls.push(args);
        if (calls.length === 1) {
          return JSON.stringify([{ name: "STAGING_SESSION_EXCHANGE_ENABLED" }]);
        }
        if (calls.length === 2) throw new Error("provider changed the prose");
        return "[]";
      },
      sleep: async () => {},
    });

    expect(result).toBe("removed");
    expect(calls).toHaveLength(3);
  });

  test("fails closed after bounded inventory failures without leaking output", async () => {
    const leaked = "sensitive-provider-diagnostic";
    const sleeps: number[] = [];
    await expect(
      ensureWorkerSecretAbsent({
        name: "STAGING_SESSION_EXCHANGE_ENABLED",
        attempts: 3,
        retryDelayMs: 7,
        run: async () => {
          throw new Error(leaked);
        },
        sleep: async (delay: number) => {
          sleeps.push(delay);
        },
      }),
    ).rejects.toThrow("Could not confirm Worker secret");
    expect(sleeps).toEqual([7, 7]);
    try {
      await ensureWorkerSecretAbsent({
        name: "STAGING_SESSION_EXCHANGE_ENABLED",
        attempts: 1,
        run: async () => {
          throw new Error(leaked);
        },
      });
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
  });
});

describe("Worker secret inventory validation", () => {
  test("rejects malformed inventories instead of fabricating absence", () => {
    expect(() => parseWorkerSecretNames("{}")).toThrow(
      "inventory was not an array",
    );
    expect(() => parseWorkerSecretNames('[{"type":"secret_text"}]')).toThrow(
      "invalid name",
    );
  });

  test("accepts only an optional exact Wrangler environment selector", () => {
    expect(validateWranglerEnvironmentArgs([])).toEqual([]);
    expect(validateWranglerEnvironmentArgs(["--env", "staging"])).toEqual([
      "--env",
      "staging",
    ]);
    expect(() => validateWranglerEnvironmentArgs(["--config", "x"])).toThrow(
      "--env selector",
    );
  });
});

import {
  parseWranglerScriptName,
  removeStalePlaintextBinding,
} from "../ensure-worker-secret-absent.mjs";

describe("parseWranglerScriptName", () => {
  const toml = [
    'name = "eliza-cloud-api"',
    "[vars]",
    'name = "decoy-inside-vars"',
    "[env.staging]",
    "[env.staging.vars]",
    'name = "decoy-inside-env-vars"',
    "[env.production]",
    'name = "custom-production-script"',
  ].join("\n");

  test("applies the <name>-<env> convention when the env has no override", () => {
    expect(parseWranglerScriptName(toml, "staging")).toBe(
      "eliza-cloud-api-staging",
    );
  });

  test("prefers an env-level name override", () => {
    expect(parseWranglerScriptName(toml, "production")).toBe(
      "custom-production-script",
    );
  });

  test("returns the top-level name without an environment", () => {
    expect(parseWranglerScriptName(toml, undefined)).toBe("eliza-cloud-api");
  });

  test("throws when no top-level name exists", () => {
    expect(() => parseWranglerScriptName("[vars]\nA = \"b\"", "staging")).toThrow(
      "wrangler.toml has no top-level name",
    );
  });
});

describe("removeStalePlaintextBinding", () => {
  const base = {
    name: "PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED",
    scriptName: "eliza-cloud-api-staging",
    accountId: "account-1",
    apiToken: "token-1",
  };

  const settingsResponse = (bindings: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ result: { bindings } }),
  });

  test("reports already-absent without patching when no plain_text binding matches", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const result = await removeStalePlaintextBinding({
      ...base,
      fetchImpl: (async (url: string, init?: { method?: string }) => {
        calls.push({ url, method: init?.method ?? "GET" });
        return settingsResponse([
          { name: "PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED", type: "secret_text" },
          { name: "OTHER_VAR", type: "plain_text", text: "x" },
        ]);
      }) as typeof fetch,
    });
    expect(result).toBe("already-absent");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  test("removes only the stale plain_text binding and round-trips the rest", async () => {
    const patched: unknown[] = [];
    let reads = 0;
    const result = await removeStalePlaintextBinding({
      ...base,
      fetchImpl: (async (url: string, init?: { method?: string; body?: FormData }) => {
        if ((init?.method ?? "GET") === "GET") {
          reads += 1;
          return settingsResponse(
            reads === 1
              ? [
                  { name: "PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED", type: "plain_text", text: "false" },
                  { name: "OTHER_SECRET", type: "secret_text" },
                  { name: "OTHER_VAR", type: "plain_text", text: "x" },
                ]
              : [
                  { name: "OTHER_SECRET", type: "secret_text" },
                  { name: "OTHER_VAR", type: "plain_text", text: "x" },
                ],
          );
        }
        const settingsBlob = init?.body?.get("settings");
        patched.push(JSON.parse(await (settingsBlob as Blob).text()));
        return { ok: true, status: 200, json: async () => ({}) };
      }) as typeof fetch,
    });
    expect(result).toBe("removed");
    expect(patched).toEqual([
      {
        bindings: [
          { name: "OTHER_SECRET", type: "secret_text" },
          { name: "OTHER_VAR", type: "plain_text", text: "x" },
        ],
      },
    ]);
  });

  test("fails closed when the binding survives the patch", async () => {
    const bindings = [
      { name: "PERSONAL_SHARED_TELEGRAM_EDGE_ENABLED", type: "plain_text", text: "false" },
    ];
    await expect(
      removeStalePlaintextBinding({
        ...base,
        fetchImpl: (async (_url: string, init?: { method?: string }) =>
          (init?.method ?? "GET") === "GET"
            ? settingsResponse(bindings)
            : { ok: true, status: 200, json: async () => ({}) }) as typeof fetch,
      }),
    ).rejects.toThrow("still contain a plain_text binding");
  });

  test("fails closed on an unreadable settings surface", async () => {
    await expect(
      removeStalePlaintextBinding({
        ...base,
        fetchImpl: (async () => ({
          ok: false,
          status: 403,
          json: async () => ({}),
        })) as typeof fetch,
      }),
    ).rejects.toThrow("read failed with status 403");
  });
});
