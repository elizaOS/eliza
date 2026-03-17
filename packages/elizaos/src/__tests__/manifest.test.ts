import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, "..", "..");

describe("examples-manifest.json", () => {
  test("manifest file exists", () => {
    const manifestPath = path.join(PACKAGE_ROOT, "examples-manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  test("manifest is valid JSON with required top-level fields", () => {
    const manifestPath = path.join(PACKAGE_ROOT, "examples-manifest.json");
    const content = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(content);

    expect(manifest.version).toBeDefined();
    expect(typeof manifest.version).toBe("string");
    expect(manifest.generatedAt).toBeDefined();
    expect(typeof manifest.generatedAt).toBe("string");
    expect(manifest.repoUrl).toBeDefined();
    expect(typeof manifest.repoUrl).toBe("string");
    expect(Array.isArray(manifest.examples)).toBe(true);
    expect(Array.isArray(manifest.categories)).toBe(true);
    expect(Array.isArray(manifest.languages)).toBe(true);
  });

  test("each example has required fields and valid structure", () => {
    const manifestPath = path.join(PACKAGE_ROOT, "examples-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    for (const example of manifest.examples) {
      expect(typeof example.name).toBe("string");
      expect(example.name.length).toBeGreaterThan(0);
      expect(typeof example.description).toBe("string");
      expect(typeof example.path).toBe("string");
      expect(Array.isArray(example.languages)).toBe(true);
      expect(typeof example.category).toBe("string");

      for (const lang of example.languages) {
        expect(typeof lang.language).toBe("string");
        expect(typeof lang.path).toBe("string");
      }
    }
  });

  test("categories are non-empty strings", () => {
    const manifestPath = path.join(PACKAGE_ROOT, "examples-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    if (manifest.examples.length > 0) {
      expect(manifest.categories.length).toBeGreaterThan(0);
    } else {
      expect(manifest.categories.length).toBe(0);
    }

    for (const cat of manifest.categories) {
      expect(typeof cat).toBe("string");
      expect(cat.length).toBeGreaterThan(0);
    }
  });

  test("languages are non-empty strings", () => {
    const manifestPath = path.join(PACKAGE_ROOT, "examples-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    if (manifest.examples.length > 0) {
      expect(manifest.languages.length).toBeGreaterThan(0);
    } else {
      expect(manifest.languages.length).toBe(0);
    }

    for (const lang of manifest.languages) {
      expect(typeof lang).toBe("string");
      expect(lang.length).toBeGreaterThan(0);
    }
  });

  test("example categories are non-empty strings", () => {
    const manifestPath = path.join(PACKAGE_ROOT, "examples-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    for (const example of manifest.examples) {
      expect(typeof example.category).toBe("string");
      expect(example.category.length).toBeGreaterThan(0);
    }
  });

  test("example languages match declared languages", () => {
    const manifestPath = path.join(PACKAGE_ROOT, "examples-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    const declaredLanguages = new Set(manifest.languages as string[]);
    for (const example of manifest.examples) {
      for (const lang of example.languages) {
        expect(declaredLanguages.has(lang.language)).toBe(true);
      }
    }
  });
});
