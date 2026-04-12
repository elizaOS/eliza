import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fixPackageJson } from "../commands/create.js";

describe("fixPackageJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-create-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("replaces workspace:* deps with the current CLI version", () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "test-project",
        dependencies: {
          elizaos: "workspace:*",
          "@elizaos/core": "workspace:*",
        },
      }),
    );

    fixPackageJson(pkgPath);

    const result = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      dependencies: Record<string, string>;
    };

    expect(result.dependencies.elizaos).not.toBe("^1.0.0");
    expect(result.dependencies["@elizaos/core"]).not.toBe("^1.0.0");

    const semverCaret = /^\^\d+\.\d+\.\d+/;
    expect(result.dependencies.elizaos).toMatch(semverCaret);
    expect(result.dependencies["@elizaos/core"]).toMatch(semverCaret);
    expect(result.dependencies.elizaos).toBe(
      result.dependencies["@elizaos/core"],
    );
  });

  test("also replaces workspace:* in devDependencies and peerDependencies", () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "test-project",
        devDependencies: { elizaos: "workspace:*" },
        peerDependencies: { "@elizaos/core": "workspace:*" },
      }),
    );

    fixPackageJson(pkgPath);

    const result = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };

    const semverCaret = /^\^\d+\.\d+\.\d+/;
    expect(result.devDependencies.elizaos).toMatch(semverCaret);
    expect(result.peerDependencies["@elizaos/core"]).toMatch(semverCaret);
  });

  test("falls back to the dist package path when resolving the CLI version", async () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "test-project",
        dependencies: { elizaos: "workspace:*" },
      }),
    );

    vi.resetModules();
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");

      return {
        ...actual,
        readFileSync: ((
          filePath: fs.PathOrFileDescriptor,
          options?: unknown,
        ) => {
          const resolvedPath =
            typeof filePath === "string" ? filePath : filePath.toString();

          if (
            resolvedPath.endsWith(
              `${path.sep}packages${path.sep}elizaos${path.sep}package.json`,
            )
          ) {
            throw new Error("primary package.json missing");
          }

          if (
            resolvedPath.endsWith(`${path.sep}packages${path.sep}package.json`)
          ) {
            return JSON.stringify({ version: "9.9.9" });
          }

          return actual.readFileSync(
            filePath,
            options as Parameters<typeof actual.readFileSync>[1],
          );
        }) as typeof actual.readFileSync,
      };
    });

    const { fixPackageJson: fixPackageJsonWithFallback } = await import(
      "../commands/create.js"
    );

    fixPackageJsonWithFallback(pkgPath);
    vi.doUnmock("node:fs");

    const result = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      dependencies: Record<string, string>;
    };

    expect(result.dependencies.elizaos).toBe("^9.9.9");
  });

  test("leaves non-workspace:* dependency values unchanged", () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "test-project",
        dependencies: {
          react: "^18.0.0",
          lodash: "~4.17.0",
          typescript: "5.0.0",
        },
      }),
    );

    fixPackageJson(pkgPath);

    const result = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      dependencies: Record<string, string>;
    };

    expect(result.dependencies.react).toBe("^18.0.0");
    expect(result.dependencies.lodash).toBe("~4.17.0");
    expect(result.dependencies.typescript).toBe("5.0.0");
  });

  test("removes the private flag so scaffolded projects can be published", () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "test-project",
        private: true,
        dependencies: {},
      }),
    );

    fixPackageJson(pkgPath);

    const result = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      private?: boolean;
    };

    expect(result.private).toBeUndefined();
  });

  test("is a no-op when the target file does not exist", () => {
    const nonExistentPath = path.join(tmpDir, "nonexistent.json");
    expect(() => fixPackageJson(nonExistentPath)).not.toThrow();
  });
});
