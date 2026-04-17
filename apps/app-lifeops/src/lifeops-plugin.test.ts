/**
 * Tests for the LifeOps plugin route registration shape.
 *
 * Validates that `lifeopsPlugin` is correctly shaped and all routes are
 * properly defined, without invoking the underlying handlers.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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

function routeKey(type: string, path: string): string {
  return `${type} ${path}`;
}

function readExactLifeOpsRouteKeys(): Set<string> {
  const sourcePath = fileURLToPath(new URL("./routes/lifeops-routes.ts", import.meta.url));
  const source = fs.readFileSync(sourcePath, "utf8");
  const matches = source.matchAll(
    /method === "([A-Z]+)"[\s\S]{0,160}?pathname === "([^"]+)"/g,
  );
  const keys = new Set<string>();
  for (const [, type, path] of matches) {
    if (path.startsWith("/api/lifeops/")) {
      keys.add(routeKey(type, path));
    }
  }
  return keys;
}

describe("lifeopsPlugin shape", () => {
  it("exports a valid Plugin with routes", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    expect(lifeopsPlugin.name).toBe("@elizaos/app-lifeops-routes");
    expect(lifeopsPlugin.routes).toBeDefined();
    expect(lifeopsPlugin.routes!.length).toBeGreaterThanOrEqual(80);
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
    expect(paths).toContain("/api/lifeops/gmail/batch-reply-drafts");
    expect(paths).toContain("/api/lifeops/browser/companions/pair");
    expect(paths).toContain("/api/lifeops/browser/companions/sync");
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

  it("registers every exact-path LifeOps handler route", async () => {
    const { lifeopsPlugin } = await import("./routes/plugin");
    const registered = new Set(
      lifeopsPlugin.routes!
        .filter((route) => route.path.startsWith("/api/lifeops/"))
        .map((route) => routeKey(route.type, route.path)),
    );
    const missing = [...readExactLifeOpsRouteKeys()]
      .filter((key) => !registered.has(key))
      .sort();

    expect(missing).toEqual([]);
  });
});
