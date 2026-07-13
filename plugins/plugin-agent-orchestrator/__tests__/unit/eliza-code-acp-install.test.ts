/** Verifies first-use provisioning of the workspace-native elizaOS ACP executable. */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspaceElizaCodeAcp } from "../../src/services/acp-service";

const roots: string[] = [];
const originalPath = process.env.PATH;

function hasRealProvisioningPrimitives(): boolean {
  const find = (name: string) =>
    (originalPath ?? "")
      .split(delimiter)
      .map((directory) => join(directory, name))
      .find((candidate) => existsSync(candidate));
  const flock = find("flock");
  const timeout = find("timeout");
  if (!flock || !timeout) return false;
  const flockVersion = spawnSync(flock, ["--version"], {
    encoding: "utf8",
    timeout: 500,
    killSignal: "SIGKILL",
  });
  const timeoutVersion = spawnSync(timeout, ["--version"], {
    encoding: "utf8",
    timeout: 500,
    killSignal: "SIGKILL",
  });
  return (
    flockVersion.status === 0 &&
    String(flockVersion.stdout).includes("flock from util-linux") &&
    timeoutVersion.status === 0 &&
    String(timeoutVersion.stdout).includes("GNU coreutils")
  );
}

const realProvisioningPrimitives = hasRealProvisioningPrimitives();

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("eliza-code-acp first-use provisioning", () => {
  it.skipIf(!realProvisioningPrimitives)(
    "builds a missing workspace executable and returns its quoted Bun command",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "eliza-acp-install-"));
      roots.push(root);
      const packageDir = join(root, "packages", "examples", "code");
      const binDir = join(root, "bin");
      mkdirSync(join(packageDir, "src"), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(packageDir, "src", "acp.ts"), "export {};\n");
      const fakeBun = join(binDir, "bun");
      // The build produces an artifact carrying the required `eliza-code-acp`
      // marker so the crash-safe validation step accepts it.
      writeFileSync(
        fakeBun,
        [
          "#!/bin/sh",
          'for argument in "$@"; do',
          '  case "$argument" in',
          `    --outfile=*) outfile="\${argument#--outfile=}" ;;`,
          `    --metafile=*) metafile="\${argument#--metafile=}" ;;`,
          "  esac",
          "done",
          'printf "// eliza-code-acp\\nbuilt" > "$outfile"',
          'printf \'{"inputs":{"src/acp.ts":{}}}\' > "$metafile"',
          "",
        ].join("\n"),
      );
      chmodSync(fakeBun, 0o755);
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

      const command = ensureWorkspaceElizaCodeAcp(root);

      // Quote-free paths round-trip bare; the quoting only kicks in for paths
      // containing spaces/quotes (covered in acp-provisioning.test.ts).
      expect(command).toBe(`${fakeBun} ${join(packageDir, "dist", "acp.js")}`);
      expect(
        await readFile(join(packageDir, "dist", "acp.js"), "utf8"),
      ).toContain("eliza-code-acp");
      expect(
        await readFile(join(packageDir, "dist", "tsconfig.json"), "utf8"),
      ).toBe('{\n  "compilerOptions": {}\n}\n');
    },
  );
});
