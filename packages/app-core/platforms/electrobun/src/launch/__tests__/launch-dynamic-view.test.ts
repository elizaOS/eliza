import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  join: vi.fn((...p: string[]) => p.join("/")),
  dirname: vi.fn(() => "/views"),
  fileURLToPath: vi.fn(() => "/views/launch-dynamic-view.ts"),
  pathToFileURL: vi.fn((p: string) => ({ href: `file://${p}` })),
}));

vi.mock("node:fs", () => ({
  existsSync: (...a: unknown[]) => mocks.existsSync(...a),
}));
vi.mock("node:path", () => ({
  join: (...a: unknown[]) => mocks.join(...(a as string[])),
  dirname: (...a: unknown[]) => mocks.dirname(...a),
}));
vi.mock("node:url", () => ({
  fileURLToPath: (...a: unknown[]) => mocks.fileURLToPath(...a),
  pathToFileURL: (...a: unknown[]) => mocks.pathToFileURL(...a),
}));

import {
  createLaunchDiagnosticsViewManifest,
  LAUNCH_DIAGNOSTICS_VIEW_ID,
} from "./launch-dynamic-view.ts";

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
