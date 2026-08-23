import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  join: vi.fn((...p: string[]) => p.join("/")),
  dirname: vi.fn((_path: string) => "/views"),
  fileURLToPath: vi.fn((_url: string | URL) => "/views/trace-dynamic-view.ts"),
  pathToFileURL: vi.fn((p: string) => ({ href: `file://${p}` })),
}));

vi.mock("node:fs", () => ({
  existsSync: (path: unknown) => mocks.existsSync(path),
}));
vi.mock("node:path", () => ({
  join: (...parts: string[]) => mocks.join(...parts),
  dirname: (path: string) => mocks.dirname(path),
}));
vi.mock("node:url", () => ({
  fileURLToPath: (url: string | URL) => mocks.fileURLToPath(url),
  pathToFileURL: (path: string) => mocks.pathToFileURL(path),
}));

import {
  createTraceDynamicViewManifest,
  TRACE_DYNAMIC_VIEW_ID,
} from "../trace-dynamic-view.ts";

describe("createTraceDynamicViewManifest", () => {
  it("builds the trace view manifest with resolved entrypoint", () => {
    mocks.existsSync.mockReturnValue(true);
    const manifest = createTraceDynamicViewManifest();
    expect(manifest.id).toBe(TRACE_DYNAMIC_VIEW_ID);
    expect(manifest.title).toBe("Agent Run Trace");
    expect(manifest.source).toBe("system");
    expect(manifest.placement).toBe("floating");
    expect(manifest.metadata).toEqual({ trace: true, productionPanel: false });
    expect(manifest.entrypoint).toContain("file://");
    expect(manifest.entrypoint).toContain("agent-run-trace.html");
  });

  it("falls back to the first candidate when the view file is missing", () => {
    mocks.existsSync.mockReturnValue(false);
    const manifest = createTraceDynamicViewManifest();
    expect(manifest.entrypoint).toContain("agent-run-trace.html");
  });
});
