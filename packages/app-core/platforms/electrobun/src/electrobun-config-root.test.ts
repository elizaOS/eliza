import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const previousOverride = process.env.ELIZA_ELECTROBUN_REPO_ROOT;
let configModulePromise: Promise<typeof import("../electrobun.config")> | null =
  null;

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electrobun-root-"));
  tempRoots.push(root);
  return root;
}

function writePackageJson(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
}

function writeWorkspaceRoot(
  root: string,
  {
    appPath,
    electrobunPath,
  }: {
    appPath: string;
    electrobunPath: string;
  },
): void {
  writePackageJson(root);
  fs.writeFileSync(path.join(root, "bun.lock"), "");
  writePackageJson(path.join(root, appPath));
  writePackageJson(path.join(root, electrobunPath));
}

async function loadConfigModule(outerRoot: string) {
  process.env.ELIZA_ELECTROBUN_REPO_ROOT = outerRoot;
  configModulePromise ??= import("../electrobun.config");
  return configModulePromise;
}

afterEach(() => {
  if (previousOverride === undefined) {
    delete process.env.ELIZA_ELECTROBUN_REPO_ROOT;
  } else {
    process.env.ELIZA_ELECTROBUN_REPO_ROOT = previousOverride;
  }

  while (tempRoots.length > 0) {
    const tempRoot = tempRoots.pop();
    if (tempRoot) {
      fs.rmSync(tempRoot, { force: true, recursive: true });
    }
  }
});

describe("Electrobun config repo root resolution", () => {
  it("prefers the outer Eliza wrapper root over the nested eliza checkout", async () => {
    const outerRoot = makeTempRoot();
    const nestedElizaRoot = path.join(outerRoot, "eliza");
    const electrobunDir = path.join(
      nestedElizaRoot,
      "packages/app-core/platforms/electrobun",
    );

    writeWorkspaceRoot(nestedElizaRoot, {
      appPath: "packages/app",
      electrobunPath: "packages/app-core/platforms/electrobun",
    });
    writeWorkspaceRoot(outerRoot, {
      appPath: "apps/app",
      electrobunPath: "eliza/packages/app-core/platforms/electrobun",
    });

    const { findElizaRepoRoot } = await loadConfigModule(outerRoot);
    delete process.env.ELIZA_ELECTROBUN_REPO_ROOT;

    expect(findElizaRepoRoot(electrobunDir)).toBe(outerRoot);
  });

  it("uses the explicit release root override when CI provides one", async () => {
    const outerRoot = makeTempRoot();
    const nestedElizaRoot = path.join(outerRoot, "eliza");
    const electrobunDir = path.join(
      nestedElizaRoot,
      "packages/app-core/platforms/electrobun",
    );

    writeWorkspaceRoot(nestedElizaRoot, {
      appPath: "packages/app",
      electrobunPath: "packages/app-core/platforms/electrobun",
    });
    writeWorkspaceRoot(outerRoot, {
      appPath: "apps/app",
      electrobunPath: "eliza/packages/app-core/platforms/electrobun",
    });

    process.env.ELIZA_ELECTROBUN_REPO_ROOT = outerRoot;

    const { resolveElectrobunRepoRoot } = await loadConfigModule(outerRoot);

    expect(resolveElectrobunRepoRoot(electrobunDir)).toBe(outerRoot);
  });
});
