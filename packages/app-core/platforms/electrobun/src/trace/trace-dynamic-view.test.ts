/** Exercises trace dynamic view behavior with deterministic app-core test fixtures. */
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
  createTraceDynamicViewManifest,
  TRACE_DYNAMIC_VIEW_ID,
} from "./trace-dynamic-view";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const VIEW_FILE = "agent-run-trace.html";
const firstCandidate = path.join(baseDir, "views", VIEW_FILE);
const secondCandidate = path.join(baseDir, "trace", "views", VIEW_FILE);

afterEach(() => {
  fsHarness.existsSync.mockReset();
  fsHarness.existsSync.mockImplementation((candidate) =>
    Boolean(fsHarness.realExistsSync?.(String(candidate))),
  );
});

describe("TRACE_DYNAMIC_VIEW_ID", () => {
  it("identifies the system agent run trace view", () => {
    expect(TRACE_DYNAMIC_VIEW_ID).toBe("agent.run.trace");
  });
});

describe("createTraceDynamicViewManifest", () => {
  it("returns the system floating manifest pointing at the on-disk trace HTML", () => {
    const manifest = createTraceDynamicViewManifest();
    const entrypointPath = fileURLToPath(manifest.entrypoint);

    expect(manifest).toEqual({
      id: TRACE_DYNAMIC_VIEW_ID,
      title: "Agent Run Trace",
      description: "Contextual trace view for agent runs and capability calls.",
      source: "system",
      entrypoint: pathToFileURL(firstCandidate).href,
      placement: "floating",
      metadata: {
        trace: true,
        productionPanel: false,
      },
    });
    expect(entrypointPath).toBe(firstCandidate);
    expect(fs.existsSync(entrypointPath)).toBe(true);
    expect(path.basename(entrypointPath)).toBe(VIEW_FILE);
    expect(fs.existsSync(secondCandidate)).toBe(false);
  });

  it("emits a file URL rather than a raw filesystem path", () => {
    const manifest = createTraceDynamicViewManifest();

    expect(manifest.entrypoint.startsWith("file:")).toBe(true);
    expect(manifest.entrypoint).not.toBe(firstCandidate);
    expect(new URL(manifest.entrypoint).protocol).toBe("file:");
  });

  it("returns a fresh object on each call without mutating prior results", () => {
    const first = createTraceDynamicViewManifest();
    const second = createTraceDynamicViewManifest();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);

    first.title = "mutated";
    first.metadata = { trace: false };
    expect(second.title).toBe("Agent Run Trace");
    expect(second.metadata).toEqual({
      trace: true,
      productionPanel: false,
    });
  });

  it("stops at the first existing candidate and does not probe the nested path", () => {
    fsHarness.existsSync.mockImplementation(
      (candidate) =>
        path.resolve(String(candidate)) === path.resolve(firstCandidate),
    );

    const manifest = createTraceDynamicViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(firstCandidate).href);
    expect(fsHarness.existsSync).toHaveBeenCalledTimes(1);
    expect(fsHarness.existsSync).toHaveBeenCalledWith(firstCandidate);
    expect(fsHarness.existsSync).not.toHaveBeenCalledWith(secondCandidate);
  });

  it("prefers the sibling views path when both candidate HTML files exist", () => {
    fsHarness.existsSync.mockReturnValue(true);

    const manifest = createTraceDynamicViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(firstCandidate).href);
    expect(manifest.entrypoint).not.toBe(pathToFileURL(secondCandidate).href);
  });

  it("falls through to the nested trace/views candidate when the sibling views file is missing", () => {
    fsHarness.existsSync.mockImplementation(
      (candidate) =>
        path.resolve(String(candidate)) === path.resolve(secondCandidate),
    );

    const manifest = createTraceDynamicViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(secondCandidate).href);
    expect(
      fsHarness.existsSync.mock.calls.map((call) =>
        path.resolve(String(call[0])),
      ),
    ).toEqual([path.resolve(firstCandidate), path.resolve(secondCandidate)]);
  });

  it("falls back to the first candidate when neither HTML path exists", () => {
    fsHarness.existsSync.mockReturnValue(false);

    const manifest = createTraceDynamicViewManifest();

    expect(manifest.entrypoint).toBe(pathToFileURL(firstCandidate).href);
    expect(fileURLToPath(manifest.entrypoint)).toBe(firstCandidate);
  });

  it("does not invent permissions or extra metadata fields", () => {
    const manifest = createTraceDynamicViewManifest();

    expect(manifest.permissions).toBeUndefined();
    expect(Object.keys(manifest.metadata ?? {})).toEqual([
      "trace",
      "productionPanel",
    ]);
  });
});
