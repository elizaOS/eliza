/**
 * Unit Tests — Service Key Authentication
 *
 * Runs the assertions in a clean subprocess so Bun's global module mocks from
 * other test files cannot poison the real auth module.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type ServiceKeyResult = {
  ok: boolean;
  value?: unknown;
  errorName?: string;
  errorMessage?: string;
};

const saved: Record<string, string | undefined> = {};

function repoRootPath(): string {
  return new URL("../..", import.meta.url).pathname;
}

function runServiceKeyCase(
  code: string,
  env: Record<string, string | undefined> = {},
): ServiceKeyResult {
  const mergedEnv = { ...process.env } as Record<string, string | undefined>;

  for (const key of [
    "WAIFU_SERVICE_KEY",
    "WAIFU_SERVICE_ORG_ID",
    "WAIFU_SERVICE_USER_ID",
  ] as const) {
    if (key in env) {
      const value = env[key];
      if (value === undefined) {
        delete mergedEnv[key];
      } else {
        mergedEnv[key] = value;
      }
    }
  }

  const result = Bun.spawnSync({
    cmd: ["bun", "--eval", code],
    cwd: repoRootPath(),
    env: mergedEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  return JSON.parse(result.stdout.toString()) as ServiceKeyResult;
}

function buildScript(action: "validate" | "require", headerValue?: string): string {
  const headersObject =
    headerValue === undefined ? "{}" : JSON.stringify({ "X-Service-Key": headerValue });

  return `
    import { validateServiceKey, requireServiceKey } from "./lib/auth/service-key";

    const request = { headers: new Headers(${headersObject}) };

    try {
      const value = ${action === "validate" ? "validateServiceKey(request)" : "requireServiceKey(request)"};
      console.log(JSON.stringify({ ok: true, value }));
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        errorName: error instanceof Error ? error.name : "Error",
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  `;
}

describe("Service Key Auth", () => {
  beforeEach(() => {
    saved.WAIFU_SERVICE_KEY = process.env.WAIFU_SERVICE_KEY;
    saved.WAIFU_SERVICE_ORG_ID = process.env.WAIFU_SERVICE_ORG_ID;
    saved.WAIFU_SERVICE_USER_ID = process.env.WAIFU_SERVICE_USER_ID;

    process.env.WAIFU_SERVICE_KEY = "test-secret-key-abc123";
    process.env.WAIFU_SERVICE_ORG_ID = "org-uuid-123";
    process.env.WAIFU_SERVICE_USER_ID = "user-uuid-456";
  });

  afterEach(() => {
    process.env.WAIFU_SERVICE_KEY = saved.WAIFU_SERVICE_KEY;
    process.env.WAIFU_SERVICE_ORG_ID = saved.WAIFU_SERVICE_ORG_ID;
    process.env.WAIFU_SERVICE_USER_ID = saved.WAIFU_SERVICE_USER_ID;
  });

  describe("validateServiceKey", () => {
    test("returns null when X-Service-Key header is missing", () => {
      const result = runServiceKeyCase(buildScript("validate"));
      expect(result).toEqual({ ok: true, value: null });
    });

    test("returns null when X-Service-Key header is empty", () => {
      const result = runServiceKeyCase(buildScript("validate", ""));
      expect(result).toEqual({ ok: true, value: null });
    });

    test("returns null when key does not match", () => {
      const result = runServiceKeyCase(buildScript("validate", "wrong-key"));
      expect(result).toEqual({ ok: true, value: null });
    });

    test("rejects wrong keys regardless of presented key length", () => {
      const sameLength = runServiceKeyCase(buildScript("validate", "wrong-secret-key"), {
        WAIFU_SERVICE_KEY: "right-secret-key",
        WAIFU_SERVICE_ORG_ID: "org-uuid-123",
        WAIFU_SERVICE_USER_ID: "user-uuid-456",
      });
      const shorter = runServiceKeyCase(buildScript("validate", "short"), {
        WAIFU_SERVICE_KEY: "right-secret-key",
        WAIFU_SERVICE_ORG_ID: "org-uuid-123",
        WAIFU_SERVICE_USER_ID: "user-uuid-456",
      });

      expect(sameLength).toEqual({ ok: true, value: null });
      expect(shorter).toEqual({ ok: true, value: null });
    });

    test("returns null when WAIFU_SERVICE_KEY env is not set", () => {
      const result = runServiceKeyCase(buildScript("validate", "test-secret-key-abc123"), {
        WAIFU_SERVICE_KEY: undefined,
        WAIFU_SERVICE_ORG_ID: "org-uuid-123",
        WAIFU_SERVICE_USER_ID: "user-uuid-456",
      });
      expect(result).toEqual({ ok: true, value: null });
    });

    test("returns identity when key matches", () => {
      const result = runServiceKeyCase(buildScript("validate", "test-secret-key-abc123"));
      expect(result).toEqual({
        ok: true,
        value: {
          organizationId: "org-uuid-123",
          userId: "user-uuid-456",
        },
      });
    });

    test("throws when key matches but org/user env vars are missing", () => {
      const result = runServiceKeyCase(buildScript("validate", "test-secret-key-abc123"), {
        WAIFU_SERVICE_KEY: "test-secret-key-abc123",
        WAIFU_SERVICE_ORG_ID: undefined,
        WAIFU_SERVICE_USER_ID: "user-uuid-456",
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain(
        "WAIFU_SERVICE_ORG_ID and WAIFU_SERVICE_USER_ID must be set",
      );
    });

    test("throws when key matches but user env var is missing", () => {
      const result = runServiceKeyCase(buildScript("validate", "test-secret-key-abc123"), {
        WAIFU_SERVICE_KEY: "test-secret-key-abc123",
        WAIFU_SERVICE_ORG_ID: "org-uuid-123",
        WAIFU_SERVICE_USER_ID: undefined,
      });
      expect(result.ok).toBe(false);
      expect(result.errorMessage).toContain(
        "WAIFU_SERVICE_ORG_ID and WAIFU_SERVICE_USER_ID must be set",
      );
    });
  });

  describe("requireServiceKey", () => {
    test("returns identity for valid key", () => {
      const result = runServiceKeyCase(buildScript("require", "test-secret-key-abc123"));
      expect(result).toEqual({
        ok: true,
        value: {
          organizationId: "org-uuid-123",
          userId: "user-uuid-456",
        },
      });
    });

    test("throws ServiceKeyAuthError for invalid key", () => {
      const result = runServiceKeyCase(buildScript("require", "wrong"));
      expect(result.ok).toBe(false);
      expect(result.errorName).toBe("ServiceKeyAuthError");
    });

    test("throws ServiceKeyAuthError for missing header", () => {
      const result = runServiceKeyCase(buildScript("require"));
      expect(result.ok).toBe(false);
      expect(result.errorName).toBe("ServiceKeyAuthError");
    });
  });
});
