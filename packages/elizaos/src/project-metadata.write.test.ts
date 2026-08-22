/**
 * Atomic-write tests for `.elizaos/template.json`. The crash seam intercepts
 * `writeFileSync` so a partial overwrite can be observed without replacing
 * `writeProjectMetadata` itself.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeCrash = vi.hoisted(() => ({
  enabled: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync(
      file: Parameters<typeof actual.writeFileSync>[0],
      data: Parameters<typeof actual.writeFileSync>[1],
      options?: Parameters<typeof actual.writeFileSync>[2],
    ) {
      if (writeCrash.enabled && typeof file === "string") {
        const base = path.basename(file);
        if (
          base === "template.json" ||
          base.startsWith(".template.json.tmp.")
        ) {
          actual.writeFileSync(file, String(data).slice(0, 20));
          throw new Error("simulated crash after partial overwrite");
        }
      }
      return actual.writeFileSync(file, data, options);
    },
  };
});

const { readProjectMetadata, writeProjectMetadata } = await import(
  "./project-metadata.js"
);

import type { ProjectTemplateMetadata } from "./types.js";

let tempDirs: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "elizaos-metadata-write-"));
  tempDirs.push(dir);
  return dir;
}

function validMetadata(pluginName: string): ProjectTemplateMetadata {
  return {
    cliVersion: "1.2.3",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    templateId: "plugin",
    templateVersion: 1,
    values: { PLUGINNAME: pluginName },
    managedFiles: { "src/index.ts": "deadbeef" },
  };
}

beforeEach(() => {
  writeCrash.enabled = false;
});

afterEach(() => {
  writeCrash.enabled = false;
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("writeProjectMetadata", () => {
  it("keeps the previous ledger when a write is interrupted mid-file", () => {
    const projectRoot = makeProjectRoot();
    const original = validMetadata("acme");
    writeProjectMetadata(projectRoot, original);
    const metadataPath = path.join(projectRoot, ".elizaos", "template.json");
    const before = readFileSync(metadataPath, "utf8");

    writeCrash.enabled = true;
    expect(() =>
      writeProjectMetadata(projectRoot, validMetadata("replaced")),
    ).toThrow(/simulated crash after partial overwrite/);

    const after = readFileSync(metadataPath, "utf8");
    expect(after).toBe(before);
    expect(readProjectMetadata(projectRoot)).toEqual(original);
  });

  it("round-trips a replacement ledger and leaves no temp files", () => {
    const projectRoot = makeProjectRoot();
    writeProjectMetadata(projectRoot, validMetadata("acme"));
    const next = validMetadata("replaced");
    writeProjectMetadata(projectRoot, next);

    expect(readProjectMetadata(projectRoot)).toEqual(next);
    const leftovers = readdirSync(path.join(projectRoot, ".elizaos"));
    expect(leftovers).toEqual(["template.json"]);
  });

  it("creates the metadata directory when it does not yet exist", () => {
    const projectRoot = makeProjectRoot();
    writeProjectMetadata(projectRoot, validMetadata("fresh"));
    expect(readProjectMetadata(projectRoot)?.values.PLUGINNAME).toBe("fresh");
  });
});
