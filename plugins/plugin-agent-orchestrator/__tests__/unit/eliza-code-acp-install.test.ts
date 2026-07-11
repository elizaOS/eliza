/** Verifies first-use provisioning of the workspace-native elizaOS ACP executable. */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspaceElizaCodeAcp } from "../../src/services/acp-service";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("eliza-code-acp first-use provisioning", () => {
  it("builds a missing workspace executable and returns its Bun command", async () => {
    const root = await mkdtemp(join(tmpdir(), "eliza-acp-install-"));
    roots.push(root);
    const packageDir = join(root, "packages", "examples", "code");
    const binDir = join(root, "bin");
    mkdirSync(join(packageDir, "src"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(packageDir, "src", "acp.ts"), "export {};\n");
    const fakeBun = join(binDir, "bun");
    writeFileSync(
      fakeBun,
      '#!/bin/sh\nmkdir -p "$3/dist"\nprintf "built" > "$3/dist/acp.js"\n',
    );
    chmodSync(fakeBun, 0o755);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

    const command = ensureWorkspaceElizaCodeAcp(root);

    expect(command).toBe(`${fakeBun} ${join(packageDir, "dist", "acp.js")}`);
    expect(await readFile(join(packageDir, "dist", "acp.js"), "utf8")).toBe(
      "built",
    );
  });
});
