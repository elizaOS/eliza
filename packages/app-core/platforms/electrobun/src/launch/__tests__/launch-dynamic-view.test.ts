import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  join: vi.fn((...p: string[]) => p.join("/")),
  dirname: vi.fn((_path: string) => "/views"),
  fileURLToPath: vi.fn((_url: string | URL) => "/views/launch-dynamic-view.ts"),
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
  createLaunchDiagnosticsViewManifest,
  LAUNCH_DIAGNOSTICS_VIEW_ID,
} from "../launch-dynamic-view.ts";

describe("createLaunchDiagnosticsViewManifest", () => {
  it("builds the launch diagnostics manifest with resolved entrypoint", () => {
    mocks.existsSync.mockReturnValue(true);
    const manifest = createLaunchDiagnosticsViewManifest();
    expect(manifest.id).toBe(LAUNCH_DIAGNOSTICS_VIEW_ID);
    expect(manifest.title).toBe("Launch Diagnostics");
    expect(manifest.source).toBe("system");
    expect(manifest.placement).toBe("debug");
    expect(manifest.metadata).toEqual({ launch: true, productionPanel: false });
    expect(manifest.entrypoint).toContain("file://");
    expect(manifest.entrypoint).toContain("launch-diagnostics.html");
  });

  it("falls back to the first candidate when the view file is missing", () => {
    mocks.existsSync.mockReturnValue(false);
    const manifest = createLaunchDiagnosticsViewManifest();
    expect(manifest.entrypoint).toContain("launch-diagnostics.html");
  });
});
