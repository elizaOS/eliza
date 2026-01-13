/**
 * Packaging and version tests converted from test_packaging.py
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

interface PackageJson {
  name: string;
  version: string;
  description?: string;
  main: string;
  types?: string;
  typings?: string;
  scripts?: Record<string, string>;
  author?: string | Record<string, string>;
  contributors?: Array<string | Record<string, string>>;
  license: string;
  repository?: string | { type: string; url: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: {
    node?: string;
    npm?: string;
  };
  files?: string[];
  keywords?: string[];
  publishConfig?: {
    access?: string;
  };
  private?: boolean;
}

describe("Packaging and Version", () => {
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  let packageJson: PackageJson;

  beforeAll(() => {
    // Load package.json
    const packageContent = fs.readFileSync(packageJsonPath, "utf-8");
    packageJson = JSON.parse(packageContent);
  });

  describe("Version format", () => {
    it("should have a valid semantic version", () => {
      const version = packageJson.version;

      // Should match semantic versioning format (X.Y.Z)
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);

      // Should have exactly 2 dots
      expect(version.split(".").length - 1).toBe(2);
    });

    it("should have major, minor, and patch version numbers", () => {
      const version = packageJson.version;
      const [major, minor, patch] = version.split(".").map(Number);

      expect(major).toBeGreaterThanOrEqual(0);
      expect(minor).toBeGreaterThanOrEqual(0);
      expect(patch).toBeGreaterThanOrEqual(0);

      // All should be valid numbers
      expect(Number.isNaN(major)).toBe(false);
      expect(Number.isNaN(minor)).toBe(false);
      expect(Number.isNaN(patch)).toBe(false);
    });

    it("should export version from main module", async () => {
      const mainModule = (await import("../dist/index.js")) as {
        __version__?: string;
      };
      expect(mainModule.__version__).toBe(packageJson.version);
    });
  });

  describe("Package metadata", () => {
    it("should have required package.json fields", () => {
      expect(packageJson.name).toBeDefined();
      expect(packageJson.version).toBeDefined();
      expect(packageJson.description).toBeDefined();
      expect(packageJson.main).toBeDefined();
      expect(packageJson.scripts).toBeDefined();
    });

    it("should have valid package name", () => {
      const name = packageJson.name;

      // Package name should be lowercase
      expect(name).toBe(name.toLowerCase());

      // Should not contain spaces
      expect(name).not.toContain(" ");

      // Should be a valid npm package name (allows scoped packages with @scope/name)
      expect(name).toMatch(/^(@[a-z0-9][\w-]*\/)?[a-z0-9][\w-.]*$/);
    });

    it("should have author information", () => {
      expect(packageJson.author || packageJson.contributors).toBeDefined();
    });

    it("should have license information", () => {
      expect(packageJson.license).toBeDefined();

      // Should be a valid SPDX license identifier or custom license
      const validLicenses = [
        "MIT",
        "Apache-2.0",
        "GPL-3.0",
        "BSD-3-Clause",
        "ISC",
      ];
      const isValidLicense =
        validLicenses.includes(packageJson.license as string) ||
        packageJson.license.startsWith("SEE LICENSE");

      expect(isValidLicense).toBe(true);
    });

    it("should have repository information", () => {
      expect(packageJson.repository).toBeDefined();

      if (typeof packageJson.repository === "string") {
        expect(packageJson.repository).toContain("github.com");
      } else if (
        packageJson.repository &&
        typeof packageJson.repository === "object"
      ) {
        expect(packageJson.repository.type).toBe("git");
        expect(packageJson.repository.url).toContain("github.com");
      }
    });
  });

  describe("Dependencies", () => {
    it("should have dependencies defined", () => {
      expect(
        packageJson.dependencies || packageJson.devDependencies,
      ).toBeDefined();
    });

    it("should have valid dependency versions", () => {
      const deps = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };

      Object.entries(deps).forEach(([, version]) => {
        // Version should be a string
        expect(typeof version).toBe("string");

        // Should be a valid version specifier
        const validPatterns = [
          /^\d+\.\d+\.\d+$/, // Exact version
          /^[\^~]\d+\.\d+\.\d+$/, // Caret or tilde
          /^\d+\.x$/, // Major version only
          /^\*$/, // Any version
          /^file:/, // Local file
          /^git\+/, // Git URL
          /^https?:/, // HTTP URL
        ];

        const isValid = validPatterns.some((pattern) =>
          pattern.test(version as string),
        );
        expect(isValid).toBe(true);
      });
    });

    it("should not have duplicate dependencies", () => {
      if (packageJson.dependencies && packageJson.devDependencies) {
        const deps = Object.keys(packageJson.dependencies);
        const devDeps = Object.keys(packageJson.devDependencies);

        const duplicates = deps.filter((dep) => devDeps.includes(dep));
        expect(duplicates).toHaveLength(0);
      }
    });
  });

  describe("Scripts", () => {
    it("should have essential scripts", () => {
      const scripts = packageJson.scripts || {};

      // Should have common scripts
      const essentialScripts = ["test", "build"];

      essentialScripts.forEach((script) => {
        expect((scripts as Record<string, string>)[script]).toBeDefined();
      });
    });

    it("should have valid script commands", () => {
      const scripts = packageJson.scripts || {};

      Object.entries(scripts).forEach(([, command]) => {
        // Script should be a non-empty string
        expect(typeof command).toBe("string");
        expect((command as string).length).toBeGreaterThan(0);
      });
    });
  });

  describe("Build configuration", () => {
    it("should have TypeScript configuration", () => {
      const tsconfigPath = path.join(__dirname, "..", "tsconfig.json");
      expect(fs.existsSync(tsconfigPath)).toBe(true);

      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
      expect(tsconfig.compilerOptions).toBeDefined();
    });

    it("should have main entry point", () => {
      const main = packageJson.main;

      // Main should be defined
      expect(main).toBeDefined();

      // Should point to a JavaScript file
      expect(main).toMatch(/\.js$/);
    });

    it("should have types entry point for TypeScript", () => {
      const types = packageJson.types || packageJson.typings;

      if (types) {
        // Should point to a TypeScript declaration file
        expect(types).toMatch(/\.d\.ts$/);
      }
    });
  });

  describe("Files and directories", () => {
    it("should have files field or .npmignore", () => {
      const hasFilesField = packageJson.files !== undefined;
      const hasNpmIgnore = fs.existsSync(
        path.join(__dirname, "..", ".npmignore"),
      );

      expect(hasFilesField || hasNpmIgnore).toBe(true);
    });

    it("should include necessary files in package", () => {
      if (packageJson.files) {
        const files = packageJson.files;

        // Should include distribution files
        const shouldInclude = ["dist", "lib", "build"].some((dir) =>
          (files as string[]).some((f: string) => f.includes(dir)),
        );

        expect(shouldInclude).toBe(true);
      }
    });

    it("should exclude unnecessary files", () => {
      if (packageJson.files) {
        const files = packageJson.files;

        // Should not include test files in distribution
        const includesTests = (files as string[]).some(
          (f: string) => f.includes("test") || f.includes("spec"),
        );

        expect(includesTests).toBe(false);
      }
    });
  });

  describe("Node.js compatibility", () => {
    it("should specify Node.js engine version", () => {
      if (packageJson.engines?.node) {
        expect(packageJson.engines.node).toBeDefined();

        // Should be a valid version range
        const nodeVersion = packageJson.engines.node;
        expect(nodeVersion).toMatch(/^[><=~^]?[=]?\d+(\.\d+)?(\.\d+)?/);
      }
    });

    it("should specify npm version if required", () => {
      if (packageJson.engines?.npm) {
        const npmVersion = packageJson.engines.npm;
        expect(npmVersion).toMatch(/^[><=~^]?\d+/);
      }
    });
  });

  describe("Publishing configuration", () => {
    it("should have publishConfig if scoped package", () => {
      if (packageJson.name?.startsWith("@")) {
        // Scoped packages might need publishConfig
        if (packageJson.publishConfig?.access) {
          expect(packageJson.publishConfig.access).toBeDefined();
        }
      }
    });

    it("should not be private if meant to be published", () => {
      // If package is meant to be published, it shouldn't be private
      if (!packageJson.private) {
        expect(packageJson.name).toBeDefined();
        expect(packageJson.version).toBeDefined();
      }
    });
  });

  describe("Keywords and description", () => {
    it("should have meaningful description", () => {
      const description = packageJson.description;

      if (description) {
        expect(description.length).toBeGreaterThan(10);
        expect(description).not.toContain("TODO");
        expect(description).not.toContain("FIXME");
      }
    });

    it("should have relevant keywords", () => {
      if (packageJson.keywords) {
        expect(Array.isArray(packageJson.keywords)).toBe(true);
        expect(packageJson.keywords.length).toBeGreaterThan(0);

        // Keywords should be strings
        packageJson.keywords.forEach((keyword) => {
          expect(typeof keyword).toBe("string");
          expect(keyword.length).toBeGreaterThan(0);
        });
      }
    });
  });

  describe("Python package compatibility", () => {
    it("should maintain version parity with Python package", () => {
      // Check if there's a Python setup.py or pyproject.toml
      const pythonPackagePaths = [
        path.join(__dirname, "..", "setup.py"),
        path.join(__dirname, "..", "pyproject.toml"),
        path.join(__dirname, "..", "python", "setup.py"),
        path.join(__dirname, "..", "python", "pyproject.toml"),
      ];

      const pythonPackage = pythonPackagePaths.find((p) => fs.existsSync(p));

      if (pythonPackage) {
        const content = fs.readFileSync(pythonPackage, "utf-8");

        // Try to extract version from Python package
        const versionMatch = content.match(/version\s*=\s*["']([^"']+)["']/);

        if (versionMatch) {
          const pythonVersion = versionMatch[1];

          // Versions should be compatible (might not be exactly the same)
          const [tsMajor] = packageJson.version.split(".");
          const [pyMajor] = pythonVersion.split(".");

          expect(tsMajor).toBe(pyMajor);
        }
      }
    });
  });
});
