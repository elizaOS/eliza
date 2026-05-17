import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDocs } from "./check-docs.mjs";

const tempRoots: string[] = [];

async function makeRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "docs-gate-"));
  tempRoots.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, "docs"), { recursive: true });
  await fs.mkdir(path.join(repoRoot, "packages", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ scripts: { dev: "echo dev" } }),
  );
  await fs.writeFile(
    path.join(repoRoot, "packages", "demo", "package.json"),
    JSON.stringify({ scripts: { test: "echo test" } }),
  );
  return repoRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("docs gate", () => {
  it("fails missing local markdown file links", async () => {
    const repoRoot = await makeRepo();
    await fs.writeFile(
      path.join(repoRoot, "docs", "index.md"),
      "# Index\n\nSee [missing](./missing.md).\n",
    );

    const result = checkDocs({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "missing-file",
        file: "docs/index.md",
        target: "./missing.md",
      }),
    );
  });

  it("fails missing root and package bun scripts", async () => {
    const repoRoot = await makeRepo();
    await fs.writeFile(
      path.join(repoRoot, "README.md"),
      "# Root\n\nRun `bun run definitely-missing`.\n",
    );
    await fs.writeFile(
      path.join(repoRoot, "packages", "demo", "README.md"),
      "# Demo\n\nRun `bun run absent` or `bun run test`.\n",
    );

    const result = checkDocs({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "missing-script",
          file: "README.md",
          script: "definitely-missing",
          cwd: ".",
        }),
        expect.objectContaining({
          type: "missing-script",
          file: "packages/demo/README.md",
          script: "absent",
          cwd: "packages/demo",
        }),
      ]),
    );
    expect(result.errors).not.toContainEqual(
      expect.objectContaining({
        type: "missing-script",
        file: "packages/demo/README.md",
        script: "test",
      }),
    );
  });

  it("checks launchdocs under the package docs tree", async () => {
    const repoRoot = await makeRepo();
    await fs.mkdir(
      path.join(repoRoot, "packages", "docs", "docs", "launchdocs"),
      {
        recursive: true,
      },
    );
    await fs.writeFile(
      path.join(
        repoRoot,
        "packages",
        "docs",
        "docs",
        "launchdocs",
        "review.md",
      ),
      "# Review\n\nRun `bun run dev`.\n",
    );

    const result = checkDocs({ repoRoot, scope: "launchdocs" });

    expect(result.ok).toBe(true);
    expect(result.checkedFiles).toEqual([
      "packages/docs/docs/launchdocs/review.md",
    ]);
  });

  it("fails launchdocs scope when no launch files are present", async () => {
    const repoRoot = await makeRepo();

    const result = checkDocs({ repoRoot, scope: "launchdocs" });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "no-docs",
      }),
    );
  });

  it("resolves docs-site absolute links under packages/docs", async () => {
    const repoRoot = await makeRepo();
    await fs.mkdir(path.join(repoRoot, "packages", "docs", "docs", "apps"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repoRoot, "packages", "docs", "docs", "apps", "desktop.md"),
      "# Desktop\n",
    );
    await fs.writeFile(
      path.join(repoRoot, "packages", "docs", "docs", "index.md"),
      "# Docs\n\nSee [desktop](/apps/desktop).\n",
    );

    const result = checkDocs({ repoRoot, scope: "docs" });

    expect(result.ok).toBe(true);
  });

  it("resolves moved relative docs links under packages/docs", async () => {
    const repoRoot = await makeRepo();
    await fs.mkdir(path.join(repoRoot, "packages", "docs", "docs", "guides"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(
        repoRoot,
        "packages",
        "docs",
        "docs",
        "guides",
        "onboarding.md",
      ),
      "# Onboarding\n",
    );
    await fs.writeFile(
      path.join(repoRoot, "packages", "demo", "README.md"),
      "# Demo\n\nSee [onboarding](../../docs/guides/onboarding.md).\n",
    );

    const result = checkDocs({ repoRoot });

    expect(result.ok).toBe(true);
  });
});
