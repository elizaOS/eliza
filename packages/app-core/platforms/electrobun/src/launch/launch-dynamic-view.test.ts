/** Exercises launch dynamic view behavior with deterministic app-core test fixtures. */
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsHarness = vi.hoisted(() => {
  const existsSync = vi.fn();
  return {
    existsSync,
    realExistsSync: undefined as
      | ((candidate: string | Buffer | URL) => boolean)
      | undefined,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsHarness.realExistsSync = actual.existsSync;
  fsHarness.existsSync.mockImplementation(actual.existsSync);
  return { ...actual, existsSync: fsHarness.existsSync };
});

import {
  createLaunchDiagnosticsViewManifest,
  LAUNCH_DIAGNOSTICS_VIEW_ID,
} from "./launch-dynamic-view";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const VIEW_FILE = "launch-diagnostics.html";
const firstCandidate = path.join(baseDir, "views", VIEW_FILE);
const secondCandidate = path.join(baseDir, "launch", "views", VIEW_FILE);

afterEach(() => {
  fsHarness.existsSync.mockReset();
  fsHarness.existsSync.mockImplementation((candidate) =>
    Boolean(fsHarness.realExistsSync?.(String(candidate))),
  );
});

describe("LAUNCH_DIAGNOSTICS_VIEW_ID", () => {
  it("identifies the system launch diagnostics view", () => {
    expect(LAUNCH_DIAGNOSTICS_VIEW_ID).toBe("launch.diagnostics");
  });
});

describe("createLaunchDiagnosticsViewManifest", () => {
  it("returns the system debug manifest pointing at the on-disk diagnostics HTML", () => {
    const manifest = createLaunchDiagnosticsViewManifest();
    const entrypointPath = fileURLToPath(manifest.entrypoint);

    expect(manifest).toEqual({
      id: LAUNCH_DIAGNOSTICS_VIEW_ID,
      title: "Launch Diagnostics",
      description:
        "Contextual diagnostics for startup, firstRun, and recovery.",
      source: "system",
      entrypoint: pathToFileURL(firstCandidate).href,
      placement: "debug",
      metadata: {
        launch: true,
        productionPanel: false,
      },
    });
    expect(entrypointPath).toBe(firstCandidate);
    expect(fs.existsSync(entrypointPath)).toBe(true);
    expect(path.basename(entrypointPath)).toBe(VIEW_FILE);
    expect(fs.existsSync(secondCandidate)).toBe(false);
  });

  it("emits a file URL rather than a raw filesystem path", () => {
    const manifest = createLaunchDiagnosticsViewManifest();

    expect(manifest.entrypoint.startsWith("file:")).toBe(true);
    expect(manifest.entrypoint).not.toBe(firstCandidate);
    expect(new URL(manifest.entrypoint).protocol).toBe("file:");
  });

  it("returns a fresh object on each call without mutating prior results", () => {
    const first = createLaunchDiagnosticsViewManifest();
    const second = createLaunchDiagnosticsViewManifest();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    first.title = "mutated";
    first.metadata = { launch: false };
    expect(second.title).toBe("Launch Diagnostics");
    expect(second.metadata).toEqual({
      launch: true,
      productionPanel: false,
    });
  });

  it("stops at the first existing candidate and does not probe the nested path", () => {
    fsHarness.existsSync.mockImplementation(
      (candidate) =>
        path.resolve(String(candidate)) === path.resolve(firstCandidate),
    );

    const manifest = createLaunchDiagnosticsViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(firstCandidate).href);
    expect(fsHarness.existsSync).toHaveBeenCalledTimes(1);
    expect(fsHarness.existsSync).toHaveBeenCalledWith(firstCandidate);
    expect(fsHarness.existsSync).not.toHaveBeenCalledWith(secondCandidate);
  });

  it("prefers the sibling views path when both candidate HTML files exist", () => {
    fsHarness.existsSync.mockReturnValue(true);

    const manifest = createLaunchDiagnosticsViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(firstCandidate).href);
    expect(manifest.entrypoint).not.toBe(pathToFileURL(secondCandidate).href);
  });

  it("falls through to the nested launch/views candidate when the sibling views file is missing", () => {
    fsHarness.existsSync.mockImplementation(
      (candidate) =>
        path.resolve(String(candidate)) === path.resolve(secondCandidate),
    );

    const manifest = createLaunchDiagnosticsViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(secondCandidate).href);
    expect(
      fsHarness.existsSync.mock.calls.map((call) =>
        path.resolve(String(call[0])),
      ),
    ).toEqual([path.resolve(firstCandidate), path.resolve(secondCandidate)]);
  });

  it("falls back to the first candidate when neither HTML path exists", () => {
    fsHarness.existsSync.mockReturnValue(false);

    const manifest = createLaunchDiagnosticsViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(firstCandidate).href);
    expect(fileURLToPath(manifest.entrypoint)).toBe(firstCandidate);
  });

  it("does not invent permissions or extra metadata fields", () => {
    const manifest = createLaunchDiagnosticsViewManifest();

    expect(manifest.permissions).toBeUndefined();
    expect(Object.keys(manifest.metadata ?? {})).toEqual([
      "launch",
      "productionPanel",
    ]);
  });
});
