/**
 * #33073: the Google disconnect route must not fold a malformed non-empty JSON
 * body into its "disconnect all on the side" defaults. A truncated body is a
 * client error (400) and must never reach the connector; an absent or empty
 * body keeps the documented bulk contract.
 *
 * Real Hono app + real zod schema + the route's exact patched body; auth and
 * the connector service are stubbed with call-ledger mocks, mirroring the
 * sibling route harnesses.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";

const disconnectManagedGoogleConnection = mock(async (_args: unknown) => ({
  ok: true,
}));

const requestSchema = z.object({
  side: z.enum(["owner", "agent"]).optional(),
  connectionId: z.string().uuid().nullable().optional(),
});

/**
 * The route's patched body, verbatim: empty/whitespace body parses as {} (the
 * documented bulk contract); non-empty bodies must be valid JSON or the request
 * fails before the connector is called.
 */
function buildApp() {
  const app = new Hono();
  app.post("/", async (c) => {
    const rawBody = await c.req.text();
    let bodyValue: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        bodyValue = JSON.parse(rawBody);
      } catch {
        return c.json(
          { error: "Invalid disconnect request: body is not valid JSON." },
          400,
        );
      }
    }
    const parsed = requestSchema.safeParse(bodyValue);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid disconnect request.", details: parsed.error.issues },
        400,
      );
    }
    await disconnectManagedGoogleConnection({
      side: parsed.data.side ?? "owner",
      connectionId: parsed.data.connectionId ?? null,
    });
    return c.json({ ok: true });
  });
  return app;
}

function post(app: ReturnType<typeof buildApp>, body: string) {
  return app.request("http://localhost/api/v1/eliza/google/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("google disconnect body validation (#33073)", () => {
  beforeEach(() => {
    disconnectManagedGoogleConnection.mockReset();
  });

  test("rejects a truncated non-empty body before any connector call", async () => {
    const response = await post(buildApp(), "{");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain("not valid JSON");
    expect(disconnectManagedGoogleConnection).not.toHaveBeenCalled();
  });

  test("keeps the empty-body bulk contract", async () => {
    const response = await post(buildApp(), "");
    expect(response.status).toBe(200);
    expect(disconnectManagedGoogleConnection).toHaveBeenCalledTimes(1);
    expect(disconnectManagedGoogleConnection).toHaveBeenCalledWith({
      side: "owner",
      connectionId: null,
    });
  });

  test("keeps the whitespace-only bulk contract", async () => {
    const response = await post(buildApp(), "   ");
    expect(response.status).toBe(200);
    expect(disconnectManagedGoogleConnection).toHaveBeenCalledTimes(1);
  });

  test("forwards an explicit side without inventing a connection id", async () => {
    const response = await post(buildApp(), JSON.stringify({ side: "agent" }));
    expect(response.status).toBe(200);
    expect(disconnectManagedGoogleConnection).toHaveBeenCalledWith({
      side: "agent",
      connectionId: null,
    });
  });

  test("still rejects schema-invalid JSON with 400", async () => {
    const response = await post(buildApp(), JSON.stringify({ side: "bogus" }));
    expect(response.status).toBe(400);
    expect(disconnectManagedGoogleConnection).not.toHaveBeenCalled();
  });

  test("accepts an explicit null connectionId as the documented bulk request", async () => {
    const response = await post(
      buildApp(),
      JSON.stringify({ connectionId: null }),
    );
    expect(response.status).toBe(200);
    expect(disconnectManagedGoogleConnection).toHaveBeenCalledTimes(1);
  });
});
