/**
 * GET /api/sandbox/screen/windows returns the same window list as the shared
 * `listWindows` enumerator.
 */
import { describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
  output: "Preview|||a.pdf<<WIN>>Finder|||Downloads<<WIN>>",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: vi.fn(() => shell.output) };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "darwin" };
});
vi.mock("../platform/helpers.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../platform/helpers.js")>();
  return {
    ...actual,
    currentPlatform: () => "darwin",
    commandExists: () => false,
  };
});

const { handleSandboxRoute } = await import("../routes/sandbox-routes.js");

describe("GET /api/sandbox/screen/windows", () => {
  it("returns one entry per macOS window", async () => {
    let body = "";
    const res = {
      setHeader: () => undefined,
      writeHead: () => res,
      end: (chunk?: string) => {
        body = String(chunk ?? "");
      },
    };
    await handleSandboxRoute(
      { method: "GET", headers: {} } as never,
      res as never,
      "/api/sandbox/screen/windows",
      "GET",
      {
        sandboxManager: { getStatus: () => ({}), getEventLog: () => [] },
      } as never,
    );
    expect(JSON.parse(body).windows).toEqual([
      { app: "Preview", title: "a.pdf", id: "a.pdf" },
      { app: "Finder", title: "Downloads", id: "Downloads" },
    ]);
  });
});
