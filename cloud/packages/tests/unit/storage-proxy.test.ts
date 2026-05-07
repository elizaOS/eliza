import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";
import { R2StorageAdapter } from "@/lib/services/storage/r2-storage-adapter";

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

interface FakeStorageState {
  files: Map<string, { bytes: Buffer; contentType: string; etag: string; modified: Date }>;
  presignCalls: Array<{ key: string; expiresIn: number }>;
}

function makeFakeAdapter(state: FakeStorageState): R2StorageAdapter {
  const fake = {
    config: {
      type: "memory",
      path: "/",
    },
    async copy(pathFrom: string, pathTo: string): Promise<void> {
      const entry = state.files.get(pathFrom);
      if (!entry) {
        throw new Error(`fake adapter: missing ${pathFrom}`);
      }
      state.files.set(pathTo, {
        bytes: Buffer.from(entry.bytes),
        contentType: entry.contentType,
        etag: `"etag-${state.files.size + 1}"`,
        modified: new Date(entry.modified),
      });
    },
    async write(key: string, data: string | Buffer): Promise<void> {
      state.files.set(key, {
        bytes: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data),
        contentType: "application/octet-stream",
        etag: `"etag-${state.files.size + 1}"`,
        modified: new Date("2026-05-02T10:00:00.000Z"),
      });
    },
    async read(key: string): Promise<Buffer> {
      const entry = state.files.get(key);
      if (!entry) {
        throw new Error(`fake adapter: missing ${key}`);
      }
      return entry.bytes;
    },
    async stat(key: string) {
      const entry = state.files.get(key);
      if (!entry) {
        throw new Error(`fake adapter: missing ${key}`);
      }
      return {
        file: key,
        contentType: entry.contentType,
        etag: entry.etag,
        size: entry.bytes.byteLength,
        modified: entry.modified,
        url: `https://example.test/${key}`,
      };
    },
    async exists(key: string): Promise<boolean> {
      return state.files.has(key);
    },
    async remove(key: string): Promise<void> {
      state.files.delete(key);
    },
    async list(prefix: string): Promise<Array<string>> {
      return Array.from(state.files.keys()).filter((k) => k.startsWith(prefix));
    },
    async presign(key: string, opts?: { expiresIn?: number }): Promise<string> {
      const expiresIn = opts?.expiresIn ?? 3600;
      state.presignCalls.push({ key, expiresIn });
      return `https://example.test/signed/${key}?exp=${expiresIn}`;
    },
  };
  return new R2StorageAdapter(fake);
}

interface QuotaState {
  used: bigint;
  limit: bigint;
}

interface MockHarness {
  quota: QuotaState;
  state: FakeStorageState;
  authResult: () => Promise<{
    id: string;
    organization_id: string;
    organization: { id: string; is_active: boolean };
    is_active: boolean;
  }>;
  creditsAvailable: boolean;
  pricing: Record<string, number>;
  r2Adapter: R2StorageAdapter | null;
}

function installMocks(harness: MockHarness): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => harness.authResult(),
  }));

  mock.module("@/lib/services/credits", () => ({
    creditsService: {
      deductCredits: async () => ({
        success: harness.creditsAvailable,
        newBalance: harness.creditsAvailable ? 100 : 0,
        transaction: null,
      }),
    },
  }));

  mock.module("@/lib/services/proxy/pricing", () => ({
    getServiceMethodCost: async (_serviceId: string, method: string) => {
      const cost = harness.pricing[method];
      if (cost === undefined) {
        throw new Error(`pricing missing for ${method}`);
      }
      return cost;
    },
  }));

  mock.module("@/lib/services/storage/r2-storage-adapter", () => ({
    R2StorageAdapter,
    getR2StorageAdapter: () => harness.r2Adapter,
    __setTestR2StorageAdapter: () => {},
  }));

  mock.module("@/db/repositories", () => ({
    orgStorageQuotaRepository: {
      tryReserveBytes: async (_orgId: string, bytes: bigint) => {
        if (harness.quota.used + bytes > harness.quota.limit) {
          return null;
        }
        harness.quota.used += bytes;
        return harness.quota.used;
      },
      releaseBytes: async (_orgId: string, bytes: bigint) => {
        harness.quota.used = harness.quota.used > bytes ? harness.quota.used - bytes : 0n;
      },
      setBytesLimit: async (_orgId: string, limit: bigint) => {
        harness.quota.limit = limit;
      },
      findByOrganization: async () => undefined,
    },
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
      debug: () => {},
    },
  }));

  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  }));
}

const validUser: MockHarness["authResult"] = async () => ({
  id: USER_ID,
  organization_id: ORG_ID,
  organization: { id: ORG_ID, is_active: true },
  is_active: true,
});

function makeHarness(overrides: Partial<MockHarness> = {}): MockHarness {
  const state: FakeStorageState = { files: new Map(), presignCalls: [] };
  const harness: MockHarness = {
    quota: { used: 0n, limit: 10n * 1024n * 1024n },
    state,
    authResult: validUser,
    creditsAvailable: true,
    pricing: {
      put: 0.0001,
      get: 0.00005,
      head: 0.00005,
      delete: 0,
      list: 0.00005,
      presign: 0.00005,
      put_per_byte: 0.000000001,
    },
    r2Adapter: makeFakeAdapter(state),
    ...overrides,
  };
  if (overrides.r2Adapter === undefined && overrides.state) {
    harness.r2Adapter = makeFakeAdapter(harness.state);
  }
  return harness;
}

interface RouteApp {
  fetch: (req: Request) => Response | Promise<Response>;
}

async function loadObjectsRoute(): Promise<RouteApp> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/apis/storage/objects/[...key]/route.ts?test=${Date.now()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/apis/storage/objects/:*{.+}", inner);
  return parent;
}

async function loadPresignRoute(): Promise<RouteApp> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/v1/apis/storage/presign/route.ts?test=${Date.now()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/apis/storage/presign", inner);
  return parent;
}

async function loadListRoute(): Promise<RouteApp> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(`../../../apps/api/v1/apis/storage/list/route.ts?test=${Date.now()}`, import.meta.url)
      .href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/v1/apis/storage/list", inner);
  return parent;
}

describe("storage proxy: /v1/apis/storage/objects/{key+}", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("PUT returns 401 when auth fails", async () => {
    const harness = makeHarness({
      authResult: async () => {
        throw new Error("unauthorized");
      },
    });
    installMocks(harness);
    mock.module("@/lib/api/cloud-worker-errors", () => ({
      failureResponse: () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    }));
    const route = await loadObjectsRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/avatar.png", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("PUT returns 503 when R2 env vars are unset", async () => {
    const harness = makeHarness({ r2Adapter: null });
    installMocks(harness);
    const route = await loadObjectsRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/avatar.png", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(res.status).toBe(503);
  });

  test("PUT returns 413 when the body would exceed org quota", async () => {
    const harness = makeHarness({
      quota: { used: 0n, limit: 5n },
    });
    installMocks(harness);
    const route = await loadObjectsRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/big.bin", {
        method: "PUT",
        body: new Uint8Array(64),
      }),
    );
    expect(res.status).toBe(413);
    expect(harness.state.files.size).toBe(0);
  });

  test("PUT returns 402 when credits run out (and refunds quota)", async () => {
    const harness = makeHarness({ creditsAvailable: false });
    installMocks(harness);
    const route = await loadObjectsRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/file.bin", {
        method: "PUT",
        body: new Uint8Array([10, 20, 30]),
      }),
    );
    expect(res.status).toBe(402);
    expect(harness.state.files.size).toBe(0);
    expect(harness.quota.used).toBe(0n);
  });

  test("PUT happy path stores bytes under the org-scoped key", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadObjectsRoute();

    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/avatar.png", {
        method: "PUT",
        body: payload,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; size: number };
    expect(body.key).toBe("avatar.png");
    expect(body.size).toBe(4);
    expect(harness.state.files.has(`org/${ORG_ID}/avatar.png`)).toBe(true);
    expect(harness.quota.used).toBe(4n);
  });

  test("validateUserKey rejects '..' path traversal segments", async () => {
    const { validateUserKeyForTest } = await import(
      new URL(
        `../../../apps/api/v1/apis/storage/objects/[...key]/route.ts?test=${Date.now()}`,
        import.meta.url,
      ).href
    );
    expect(validateUserKeyForTest("foo/../bar")).toEqual({
      error: "Object key may not contain '..' path segments",
    });
    expect(validateUserKeyForTest("\u0000bad")).toEqual({
      error: "Object key may not contain NUL bytes",
    });
    expect(validateUserKeyForTest("")).toEqual({ error: "Object key is required" });
    expect(validateUserKeyForTest("foo/bar.png")).toEqual({ key: "foo/bar.png" });
  });

  test("GET returns the stored bytes with the correct content-type", async () => {
    const harness = makeHarness();
    harness.state.files.set(`org/${ORG_ID}/note.txt`, {
      bytes: Buffer.from("hello"),
      contentType: "text/plain",
      etag: '"e1"',
      modified: new Date("2026-05-02T10:00:00.000Z"),
    });
    installMocks(harness);
    const route = await loadObjectsRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/note.txt"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    const text = await res.text();
    expect(text).toBe("hello");
  });

  test("GET returns 404 when the object does not exist", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadObjectsRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/missing.bin"),
    );
    expect(res.status).toBe(404);
  });

  test("DELETE releases bytes back to the quota", async () => {
    const harness = makeHarness();
    harness.quota.used = 100n;
    harness.state.files.set(`org/${ORG_ID}/garbage.bin`, {
      bytes: Buffer.alloc(100),
      contentType: "application/octet-stream",
      etag: '"e1"',
      modified: new Date("2026-05-02T10:00:00.000Z"),
    });
    installMocks(harness);
    const route = await loadObjectsRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/objects/garbage.bin", {
        method: "DELETE",
      }),
    );
    expect(res.status).toBe(204);
    expect(harness.state.files.size).toBe(0);
    expect(harness.quota.used).toBe(0n);
  });
});

describe("storage proxy: POST /v1/apis/storage/presign", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("returns 503 when R2 unset", async () => {
    const harness = makeHarness({ r2Adapter: null });
    installMocks(harness);
    const route = await loadPresignRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/presign", {
        method: "POST",
        body: JSON.stringify({ key: "foo.bin", operation: "get" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(503);
  });

  test("returns a signed url for a valid get request", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadPresignRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/presign", {
        method: "POST",
        body: JSON.stringify({ key: "asset.png", operation: "get", expiresIn: 600 }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.url).toContain(`org/${ORG_ID}/asset.png`);
    expect(body.url).toContain("exp=600");
    expect(harness.state.presignCalls.at(-1)).toEqual({
      key: `org/${ORG_ID}/asset.png`,
      expiresIn: 600,
    });
  });

  test("rejects malformed input with 400", async () => {
    const harness = makeHarness();
    installMocks(harness);
    const route = await loadPresignRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/presign", {
        method: "POST",
        body: JSON.stringify({ key: "asset.png", operation: "rotate" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 402 when credits run out", async () => {
    const harness = makeHarness({ creditsAvailable: false });
    installMocks(harness);
    const route = await loadPresignRoute();

    const res = await route.fetch(
      new Request("https://api.test/api/v1/apis/storage/presign", {
        method: "POST",
        body: JSON.stringify({ key: "x.bin", operation: "put" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(res.status).toBe(402);
  });
});

describe("storage proxy: GET /v1/apis/storage/list", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    mock.restore();
  });

  test("scopes listing to the caller's organization and strips the prefix", async () => {
    const harness = makeHarness();
    harness.state.files.set(`org/${ORG_ID}/a.txt`, {
      bytes: Buffer.from("a"),
      contentType: "text/plain",
      etag: '"a"',
      modified: new Date("2026-05-02T10:00:00.000Z"),
    });
    harness.state.files.set(`org/${ORG_ID}/sub/b.txt`, {
      bytes: Buffer.from("bb"),
      contentType: "text/plain",
      etag: '"b"',
      modified: new Date("2026-05-02T10:01:00.000Z"),
    });
    harness.state.files.set("org/some-other-org/c.txt", {
      bytes: Buffer.from("ccc"),
      contentType: "text/plain",
      etag: '"c"',
      modified: new Date("2026-05-02T10:02:00.000Z"),
    });
    installMocks(harness);
    const route = await loadListRoute();

    const res = await route.fetch(new Request("https://api.test/api/v1/apis/storage/list?prefix="));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ key: string; size: number }>;
      truncated: boolean;
    };
    const keys = body.items.map((i) => i.key).sort();
    expect(keys).toEqual(["a.txt", "sub/b.txt"]);
    expect(body.truncated).toBe(false);
  });

  test("returns 503 when R2 unset", async () => {
    const harness = makeHarness({ r2Adapter: null });
    installMocks(harness);
    const route = await loadListRoute();

    const res = await route.fetch(new Request("https://api.test/api/v1/apis/storage/list?prefix="));
    expect(res.status).toBe(503);
  });
});
