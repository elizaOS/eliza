/**
 * `POST /api/eliza-app/cli-auth/complete` untrusted JSON body contract.
 *
 * After a valid Eliza-app session, the handler used `c.req.json()` inside the
 * same try that maps every throw to 500 "Failed to complete CLI auth". Syntax
 * errors and non-object JSON are client garbage and must be 400
 * `{ success: false, error: "Invalid JSON body" }` before any CLI-session
 * lookup. Missing `session_id` on a real object stays 400 `Missing session_id`.
 * Deterministic Hono tests against the real route (auth + db mocked).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const validateAuthHeader = mock(async (header: string) =>
  header.startsWith("Bearer ")
    ? { userId: "user-cli-auth", organizationId: "org-cli-auth" }
    : null,
);

const limit = mock(async () => []);
const whereSelect = mock(() => ({ limit }));
const from = mock(() => ({ where: whereSelect }));
const select = mock(() => ({ from }));
const whereUpdate = mock(async () => undefined);
const set = mock(() => ({ where: whereUpdate }));
const update = mock(() => ({ set }));

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppSessionService: { validateAuthHeader },
}));

mock.module("@/db/client", () => ({ db: { select, update } }));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
    info: mock(() => undefined),
  },
}));

const { default: app } = await import("./route");

function post(body: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: {
        authorization: "Bearer eliza-app-session",
        "content-type": "application/json",
        ...headers,
      },
      body,
    }),
  );
}

describe("POST /api/eliza-app/cli-auth/complete JSON body", () => {
  beforeEach(() => {
    validateAuthHeader.mockClear();
    select.mockClear();
    update.mockClear();
    limit.mockClear();
  });

  test("returns 400 for syntactically invalid JSON", async () => {
    const res = await post("{not-json");
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(select).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test("returns 400 for a JSON array", async () => {
    const res = await post('["session_id"]');
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(select).not.toHaveBeenCalled();
  });

  test("returns 400 for a JSON primitive", async () => {
    const res = await post('"cli-session"');
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(select).not.toHaveBeenCalled();
  });

  test("returns 400 for JSON null", async () => {
    const res = await post("null");
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "Invalid JSON body",
    });
    expect(select).not.toHaveBeenCalled();
  });

  test("keeps the missing-session_id 400 on a JSON object", async () => {
    const res = await post("{}");
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "Missing session_id",
    });
    expect(select).not.toHaveBeenCalled();
  });

  test("keeps unauthorized before reading the body", async () => {
    const res = await post("{not-json", { authorization: "" });
    expect(res.status).toBe(401);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      success: false,
      error: "Unauthorized",
    });
    expect(validateAuthHeader).not.toHaveBeenCalled();
  });
});
