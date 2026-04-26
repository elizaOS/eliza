import {
  DatabaseSync,
} from "@elizaos/agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  __internal,
  addAutofillWhitelistAction,
  listAutofillWhitelistAction,
  requestFieldFillAction,
} from "../src/actions/autofill.js";
import {
  DEFAULT_AUTOFILL_WHITELIST,
  extractRegistrableDomain,
  isUrlWhitelisted,
  normalizeAutofillDomain,
} from "../src/lifeops/autofill-whitelist.js";

const ORIGINAL_ENV = { ...process.env };

const AGENT_ID = "00000000-0000-0000-0000-000000000003";

type SqlQuery = {
  queryChunks?: Array<{ value?: unknown }>;
};

function extractSqlText(query: SqlQuery): string {
  if (!Array.isArray(query.queryChunks)) return "";
  return query.queryChunks
    .map((chunk) => {
      const value = chunk?.value;
      if (Array.isArray(value)) return value.join("");
      return String(value ?? "");
    })
    .join("");
}

function createFeatureEnabledDb() {
  const sqlite = new DatabaseSync(":memory:");
  const now = "2026-04-20T00:00:00.000Z";
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS lifeops_features (
      feature_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      source TEXT NOT NULL,
      enabled_at TEXT,
      enabled_by TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO lifeops_features (
      feature_key, enabled, source, enabled_at, enabled_by, metadata, created_at, updated_at
    ) VALUES (
      'browser.automation', 1, 'local', '${now}', NULL, '{}', '${now}', '${now}'
    );
  `);
  return {
    execute: async (query: SqlQuery) => {
      const sql = extractSqlText(query).trim();
      if (sql.length === 0) return [];
      if (/^(select|pragma)\b/i.test(sql)) {
        return sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
      }
      sqlite.exec(sql);
      return [];
    },
  };
}

function makeMessage() {
  // entityId === agentId → isAgentSelf → hasOwnerAccess returns true
  return {
    entityId: AGENT_ID,
    roomId: "00000000-0000-0000-0000-000000000002",
    content: { text: "autofill" },
  } as unknown as Parameters<
    NonNullable<typeof requestFieldFillAction.handler>
  >[1];
}

function makeRuntime(initial: readonly string[] = []) {
  let cache: readonly string[] = initial;
  return {
    agentId: AGENT_ID,
    getSetting: (_key: string) => undefined,
    async getCache<T>(key: string): Promise<T | null | undefined> {
      if (key === __internal.WHITELIST_CACHE_KEY) {
        return cache as unknown as T;
      }
      return null;
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      if (key === __internal.WHITELIST_CACHE_KEY) {
        cache = value as unknown as readonly string[];
      }
      return true;
    },
    adapter: {
      db: createFeatureEnabledDb(),
    },
  } as unknown as Parameters<
    NonNullable<typeof requestFieldFillAction.handler>
  >[0];
}

beforeEach(() => {
  delete process.env.MILADY_DEVICE_BUS_URL;
  delete process.env.MILADY_DEVICE_BUS_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("autofill-whitelist helpers", () => {
  test("extractRegistrableDomain handles URLs and bare hosts", () => {
    expect(extractRegistrableDomain("https://github.com/login")).toBe(
      "github.com",
    );
    expect(extractRegistrableDomain("mail.google.com")).toBe("google.com");
    expect(extractRegistrableDomain("localhost")).toBeNull();
    expect(extractRegistrableDomain("")).toBeNull();
  });
  test("isUrlWhitelisted accepts subdomains via parent entry", () => {
    expect(
      isUrlWhitelisted("https://mail.google.com/", ["google.com"]).allowed,
    ).toBe(true);
    expect(
      isUrlWhitelisted("https://notgithub.com/", ["github.com"]).allowed,
    ).toBe(false);
  });
  test("normalizeAutofillDomain is idempotent", () => {
    expect(normalizeAutofillDomain("GitHub.com")).toBe("github.com");
    expect(normalizeAutofillDomain("https://github.com/x")).toBe("github.com");
  });
});

describe("REQUEST_FIELD_FILL — whitelist invariant", () => {
  test("refuses non-whitelisted domain without dispatching", async () => {
    process.env.MILADY_DEVICE_BUS_URL = "https://example.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await requestFieldFillAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          tabUrl: "http://sketchy-phishing-clone.example/login",
          fieldPurpose: "password",
        },
      },
    );
    const r = result as {
      success: boolean;
      data?: Record<string, unknown>;
      values?: Record<string, unknown>;
    };
    expect(r.success).toBe(false);
    expect(r.data?.reason).toBe("not-whitelisted");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("refuses blank tabUrl", async () => {
    const result = await requestFieldFillAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { tabUrl: "", fieldPurpose: "password" } },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    expect(r.data?.error).toBe("MISSING_TAB_URL");
  });

  test("rejects invalid fieldPurpose", async () => {
    const result = await requestFieldFillAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          tabUrl: "https://github.com/login",
          fieldPurpose: "credit-card",
        },
      },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    expect(r.data?.error).toBe("INVALID_FIELD_PURPOSE");
  });

  test("whitelisted domain dispatches via device bus", async () => {
    process.env.MILADY_DEVICE_BUS_URL = "https://example.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
    const result = await requestFieldFillAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          tabUrl: "https://mail.google.com/u/0",
          fieldPurpose: "password",
        },
      },
    );
    const r = result as {
      success: boolean;
      data?: Record<string, unknown>;
    };
    expect(r.success).toBe(true);
    expect(r.data?.registrableDomain).toBe("google.com");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    // credential-flow invariant: payload carries no credential material
    expect(body).not.toHaveProperty("password");
    expect(body).not.toHaveProperty("secret");
    expect(body.payload).toMatchObject({
      tabUrl: "https://mail.google.com/u/0",
      fieldPurpose: "password",
    });
  });

  test("whitelisted domain with no device bus reports extension-unreachable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await requestFieldFillAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      {
        parameters: {
          tabUrl: "https://github.com/login",
          fieldPurpose: "password",
        },
      },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    expect(r.data?.reason).toBe("extension-unreachable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ADD_AUTOFILL_WHITELIST — explicit confirmation required", () => {
  test("requires confirmed: true", async () => {
    const runtime = makeRuntime();
    const result = await addAutofillWhitelistAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { parameters: { domain: "example.test" } },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    expect(r.data?.error).toBe("CONFIRMATION_REQUIRED");
  });

  test("adds a new domain when confirmed", async () => {
    const runtime = makeRuntime();
    const result = await addAutofillWhitelistAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { parameters: { domain: "example.test", confirmed: true } },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(true);
    expect(r.data?.added).toBe(true);
    expect(r.data?.domain).toBe("example.test");
    const effective = await __internal.effectiveWhitelist(runtime);
    expect(effective).toContain("example.test");
  });

  test("no-op when domain already in defaults", async () => {
    const runtime = makeRuntime();
    const result = await addAutofillWhitelistAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { parameters: { domain: "github.com", confirmed: true } },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(true);
    expect(r.data?.added).toBe(false);
    expect(r.data?.source).toBe("default");
  });

  test("rejects invalid domain input", async () => {
    const result = await addAutofillWhitelistAction.handler!(
      makeRuntime(),
      makeMessage(),
      undefined,
      { parameters: { domain: "localhost", confirmed: true } },
    );
    const r = result as { success: boolean; data?: Record<string, unknown> };
    expect(r.success).toBe(false);
    expect(r.data?.error).toBe("INVALID_DOMAIN");
  });
});

describe("LIST_AUTOFILL_WHITELIST", () => {
  test("returns defaults plus user additions", async () => {
    const runtime = makeRuntime(["example.test"]);
    const result = await listAutofillWhitelistAction.handler!(
      runtime,
      makeMessage(),
      undefined,
      { parameters: {} },
    );
    const r = result as {
      success: boolean;
      data?: {
        defaults?: readonly string[];
        userAdded?: readonly string[];
        effective?: readonly string[];
      };
    };
    expect(r.success).toBe(true);
    expect(r.data?.defaults).toEqual([...DEFAULT_AUTOFILL_WHITELIST]);
    expect(r.data?.userAdded).toContain("example.test");
    expect(r.data?.effective).toContain("github.com");
    expect(r.data?.effective).toContain("example.test");
  });
});
