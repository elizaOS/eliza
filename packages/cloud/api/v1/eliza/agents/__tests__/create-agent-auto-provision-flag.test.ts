import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";

const createAgentSchema = z.object({
  agentName: z.string().min(1).max(100),
  autoProvision: z.boolean().optional(),
});

function buildApp() {
  const app = new Hono<{ Bindings: Record<string, unknown> }>();
  app.post("/", (c) => {
    const parsed = createAgentSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ success: false, error: "Invalid request data" }, 400);
    }
    const requestedAutoProvision = c.req.query("autoProvision");
    if (
      requestedAutoProvision != null &&
      requestedAutoProvision !== "" &&
      requestedAutoProvision !== "true" &&
      requestedAutoProvision !== "false"
    ) {
      return c.json(
        {
          success: false,
          error: "Invalid autoProvision",
          message: 'autoProvision must be "true" or "false".',
        },
        400,
      );
    }
    const autoProvision =
      requestedAutoProvision !== "false" &&
      parsed.data.autoProvision !== false;
    return c.json({ success: true, autoProvision }, 200);
  });
  return app;
}

describe("POST /api/v1/eliza/agents autoProvision flag", () => {
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    app = buildApp();
  });

  const req = (body: unknown, query = "") =>
    new Request("http://localhost/" + (query ? "?" + query : ""), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("rejects unknown autoProvision token", async () => {
    const res = await app.request(req({ agentName: "a" }, "autoProvision=TRUE"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Invalid autoProvision");
  });

  test("rejects numeric autoProvision token", async () => {
    const res = await app.request(req({ agentName: "a" }, "autoProvision=1"));
    expect(res.status).toBe(400);
  });

  test("accepts autoProvision=false", async () => {
    const res = await app.request(req({ agentName: "a" }, "autoProvision=false"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.autoProvision).toBe(false);
  });

  test("defaults to autoProvision=true when omitted", async () => {
    const res = await app.request(req({ agentName: "a" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.autoProvision).toBe(true);
  });
});
