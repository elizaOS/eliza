/** Exercises built-in dynamic-view entrypoint resolution and independent manifests with real URL/path conversion. */
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLaunchDiagnosticsViewManifest } from "../launch/launch-dynamic-view";
import { createTraceDynamicViewManifest } from "../trace/trace-dynamic-view";
import { DynamicViewRegistry } from "./registry";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

beforeEach(() => vi.mocked(fs.existsSync).mockReturnValue(false));

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe.each([
  ["launch", "launch-diagnostics.html", createLaunchDiagnosticsViewManifest],
  ["trace", "agent-run-trace.html", createTraceDynamicViewManifest],
] as const)("%s system view", (directory, filename, createManifest) => {
  const first = path.join(sourceRoot, directory, "views", filename);
  const second = path.join(sourceRoot, directory, directory, "views", filename);

  it.each([
    [[first], first],
    [[first, second], first],
    [[second], second],
    [[], first],
  ])("selects the entrypoint for available paths %j", (available, expected) => {
    vi.mocked(fs.existsSync).mockImplementation((candidate) =>
      available.includes(String(candidate)),
    );
    const registry = new DynamicViewRegistry();
    const manifest = createManifest();
    registry.register(manifest);
    expect(registry.get(manifest.id)).toMatchObject({
      entrypoint: pathToFileURL(expected).href,
    });
  });

  it("creates independently customizable manifests pointing to readable HTML", () => {
    const firstManifest = createManifest();
    expect(fs.readFileSync(new URL(firstManifest.entrypoint), "utf8")).toMatch(
      /<!doctype html>/i,
    );
    const secondManifest = createManifest();
    const original = structuredClone(secondManifest);
    firstManifest.title = "customized";
    firstManifest.metadata = { customized: true };
    expect(secondManifest).toEqual(original);
    expect(createManifest()).toEqual(original);
  });
});
