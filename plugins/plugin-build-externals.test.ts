import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock("node:fs/promises", () => ({
  default: { readFile: mocks.readFile },
  readFile: mocks.readFile,
}));

import { externalsFromPackageJson } from "./build-externals";

function pkg(partial: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "p",
    dependencies: { a: "^1.0.0", b: "^2.0.0" },
    peerDependencies: { peer1: "^1.0.0" },
    optionalDependencies: { opt1: "^1.0.0" },
    ...partial,
  });
}

describe("externalsFromPackageJson boundary", () => {
  it("externalizes runtime, peer, and optional deps, sorted for stable diffs", async () => {
    mocks.readFile.mockResolvedValue(pkg());
    await expect(externalsFromPackageJson("/x/package.json")).resolves.toEqual([
      "a",
      "b",
      "opt1",
      "peer1",
    ]);
  });

  it("excludes peer deps when includePeer=false", async () => {
    mocks.readFile.mockResolvedValue(pkg());
    await expect(
      externalsFromPackageJson("/x/package.json", { includePeer: false }),
    ).resolves.toEqual(["a", "b", "opt1"]);
  });

  it("excludes optional deps when includeOptional=false", async () => {
    mocks.readFile.mockResolvedValue(pkg());
    await expect(
      externalsFromPackageJson("/x/package.json", { includeOptional: false }),
    ).resolves.toEqual(["a", "b", "peer1"]);
  });

  it("merges caller-supplied extras and dedupes against package deps", async () => {
    mocks.readFile.mockResolvedValue(pkg());
    await expect(
      externalsFromPackageJson("/x/package.json", { extra: ["node:fs", "a"] }),
    ).resolves.toEqual(["a", "b", "node:fs", "opt1", "peer1"]);
  });

  it("tolerates missing dependency sections", async () => {
    mocks.readFile.mockResolvedValue(
      pkg({
        dependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
      }),
    );
    await expect(externalsFromPackageJson("/x/package.json")).resolves.toEqual(
      [],
    );
  });

  it("propagates malformed JSON as a hard error (fail loud, no partial externals)", async () => {
    mocks.readFile.mockResolvedValue("{ not json");
    await expect(externalsFromPackageJson("/x/package.json")).rejects.toThrow(
      SyntaxError,
    );
  });

  it("propagates read failures instead of returning an empty list", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT: no such file"));
    await expect(externalsFromPackageJson("/x/package.json")).rejects.toThrow(
      "ENOENT",
    );
  });
});
