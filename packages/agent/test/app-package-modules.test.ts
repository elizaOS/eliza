import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveWorkspacePackageDir } from "../src/services/app-package-modules.ts";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("reports an unreadable workspace package manifest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eliza-app-package-"));
  roots.push(root);
  const packageDir = path.join(root, "plugins", "broken-app");
  await mkdir(packageDir, { recursive: true });
  const manifestPath = path.join(packageDir, "package.json");
  await writeFile(manifestPath, '{"name":');
  vi.stubEnv("ELIZA_WORKSPACE_ROOT", root);

  await expect(
    resolveWorkspacePackageDir("@elizaos/plugin-broken-app"),
  ).rejects.toMatchObject({
    code: "APP_MODULE_RESOLUTION_FAILED",
    context: { manifestPath },
  });
});
