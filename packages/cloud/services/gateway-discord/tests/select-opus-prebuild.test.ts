/**
 * Exercises the fail-closed validation around the shared Opus container
 * selector with synthetic manifests and binaries; real addons run in Docker.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { selectOpusPrebuild } from "../scripts/select-opus-prebuild";

const temporaryDirectories: string[] = [];

async function fakeService(version = "0.10.0"): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gateway-opus-selector-"));
  temporaryDirectories.push(root);
  const packageRoot = path.join(root, "node_modules", "@discordjs", "opus");
  const prebuild = path.join(
    packageRoot,
    "prebuild",
    "node-v108-napi-v3-linux-x64-musl-1.2.5",
  );
  await mkdir(prebuild, { recursive: true });
  await Bun.write(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ version, binary: { module_path: "untrusted" } }),
  );
  await Bun.write(path.join(prebuild, "opus.node"), "not an Opus addon");
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("rejects unsupported container architectures before inspecting files", async () => {
  await expect(selectOpusPrebuild("missing", "riscv64")).rejects.toThrow(
    /no verified Alpine prebuild.*riscv64/i,
  );
});

test("rejects dependency version drift", async () => {
  const service = await fakeService("0.10.1");
  await expect(selectOpusPrebuild(service, "amd64")).rejects.toThrow(
    /expected @discordjs\/opus 0\.10\.0, found 0\.10\.1/,
  );
});

test("rejects a selected binary whose digest is not pinned", async () => {
  const service = await fakeService();
  await expect(selectOpusPrebuild(service, "amd64")).rejects.toThrow(
    /integrity mismatch/i,
  );
});
