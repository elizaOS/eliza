/**
 * Tests for the LifeOps plugin route registration shape.
 *
 * Validates that `lifeopsPlugin` is correctly shaped and all routes are
 * properly defined, without invoking the underlying handlers.
 */
import { describe, expect, it, vi } from "vitest";

// Stub the heavy handler modules and their dependencies
vi.mock("./routes/lifeops-routes", () => ({
  handleLifeOpsRoutes: vi.fn(async () => {}),
}));
vi.mock("./routes/website-blocker-routes", () => ({
  handleWebsiteBlockerRoutes: vi.fn(async () => {}),
}));
vi.mock("@elizaos/agent/api/http-helpers", () => ({
  sendJson: vi.fn(),
  sendJsonError: vi.fn(),
  readJsonBody: vi.fn(),
}));
vi.mock("@elizaos/agent/api/server-helpers", () => ({
  decodePathComponent: vi.fn((s: string) => s),
}));

describe("lifeopsPlugin shape", () => {
  it("exports a valid Plugin with routes", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    expect(lifeopsPlugin.name).toBe("@elizaos/app-lifeops-routes");
    expect(lifeopsPlugin.routes).toBeDefined();
    // 50 static + 22 dynamic + 5 website-blocker = 77
    expect(lifeopsPlugin.routes!.length).toBeGreaterThanOrEqual(70);
  });

  it("all routes have rawPath: true", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    for (const route of lifeopsPlugin.routes!) {
      expect((route as Record<string, unknown>).rawPath).toBe(true);
    }
  });

  it("all routes have valid type and handler", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    const validTypes = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);
    for (const route of lifeopsPlugin.routes!) {
      expect(validTypes.has(route.type)).toBe(true);
      expect(typeof route.handler).toBe("function");
    }
  });

  it("includes expected static LifeOps routes", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    const paths = lifeopsPlugin.routes!.map((r) => r.path);

    expect(paths).toContain("/api/lifeops/app-state");
    expect(paths).toContain("/api/lifeops/calendar/feed");
    expect(paths).toContain("/api/lifeops/gmail/triage");
    expect(paths).toContain("/api/lifeops/connectors/google/status");
    expect(paths).toContain("/api/lifeops/connectors/x/status");
    expect(paths).toContain("/api/lifeops/goals");
    expect(paths).toContain("/api/lifeops/definitions");
    expect(paths).toContain("/api/lifeops/workflows");
    expect(paths).toContain("/api/lifeops/overview");
    expect(paths).toContain("/api/lifeops/browser/sessions");
  });

  it("includes expected dynamic LifeOps routes", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    const paths = lifeopsPlugin.routes!.map((r) => r.path);

    expect(paths).toContain("/api/lifeops/definitions/:id");
    expect(paths).toContain("/api/lifeops/goals/:id");
    expect(paths).toContain("/api/lifeops/goals/:id/review");
    expect(paths).toContain("/api/lifeops/workflows/:id");
    expect(paths).toContain("/api/lifeops/workflows/:id/run");
    expect(paths).toContain("/api/lifeops/browser/sessions/:id");
    expect(paths).toContain("/api/lifeops/occurrences/:id/complete");
    expect(paths).toContain("/api/lifeops/website-access/callbacks/:key/resolve");
  });

  it("includes website-blocker routes", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    const paths = lifeopsPlugin.routes!.map((r) => r.path);

    expect(paths).toContain("/api/website-blocker");
    expect(paths).toContain("/api/website-blocker/status");
  });

  it("Google callback and success routes are public", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");

    const callbackRoute = lifeopsPlugin.routes!.find(
      (r) => r.path === "/api/lifeops/connectors/google/callback",
    );
    const successRoute = lifeopsPlugin.routes!.find(
      (r) => r.path === "/api/lifeops/connectors/google/success",
    );

    expect(callbackRoute).toBeDefined();
    expect((callbackRoute as Record<string, unknown>).public).toBe(true);
    expect(successRoute).toBeDefined();
    expect((successRoute as Record<string, unknown>).public).toBe(true);
  });

  it("handlers delegate to the underlying handler modules", async () => {
    const { handleLifeOpsRoutes } = await import("./routes/lifeops-routes");
    const { lifeopsPlugin } = await import("./routes/plugin");

    const route = lifeopsPlugin.routes!.find(
      (r) => r.path === "/api/lifeops/app-state" && r.type === "GET",
    );
    expect(route).toBeDefined();

    const req = { method: "GET", url: "/api/lifeops/app-state" };
    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await route!.handler(req, res, null);

    expect(handleLifeOpsRoutes).toHaveBeenCalled();
  });
});
