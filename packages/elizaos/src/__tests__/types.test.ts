import { describe, expect, test } from "vitest";
import type {
  CreateOptions,
  Example,
  ExampleLanguage,
  ExamplesManifest,
  InfoOptions,
} from "../types.js";

describe("ExampleLanguage type", () => {
  test("minimal valid ExampleLanguage", () => {
    const lang: ExampleLanguage = {
      language: "typescript",
      path: "examples/basic/typescript",
    };
    expect(lang.language).toBe("typescript");
    expect(lang.path).toBe("examples/basic/typescript");
  });

  test("ExampleLanguage with optional fields", () => {
    const lang: ExampleLanguage = {
      language: "typescript",
      path: "examples/basic/typescript",
      hasPackageJson: true,
      hasRequirementsTxt: false,
      hasCargoToml: false,
      hasPyprojectToml: false,
    };
    expect(lang.hasPackageJson).toBe(true);
    expect(lang.hasRequirementsTxt).toBe(false);
  });
});

describe("Example type", () => {
  test("valid Example with all required fields", () => {
    const example: Example = {
      name: "basic-chat",
      description: "A basic chat example",
      path: "examples/basic-chat",
      languages: [
        { language: "typescript", path: "examples/basic-chat/typescript" },
        { language: "python", path: "examples/basic-chat/python" },
      ],
      category: "getting-started",
    };
    expect(example.name).toBe("basic-chat");
    expect(example.languages).toHaveLength(2);
    expect(example.category).toBe("getting-started");
  });

  test("Example with empty languages array", () => {
    const example: Example = {
      name: "empty",
      description: "No languages",
      path: "examples/empty",
      languages: [],
      category: "misc",
    };
    expect(example.languages).toHaveLength(0);
  });
});

describe("ExamplesManifest type", () => {
  test("valid manifest structure", () => {
    const manifest: ExamplesManifest = {
      version: "1.0.0",
      generatedAt: "2024-01-01T00:00:00Z",
      repoUrl: "https://github.com/elizaos/eliza",
      examples: [
        {
          name: "basic",
          description: "Basic example",
          path: "examples/basic",
          languages: [{ language: "typescript", path: "examples/basic/ts" }],
          category: "getting-started",
        },
      ],
      categories: ["getting-started"],
      languages: ["typescript"],
    };
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.examples).toHaveLength(1);
    expect(manifest.categories).toHaveLength(1);
    expect(manifest.languages).toHaveLength(1);
  });

  test("empty manifest arrays", () => {
    const manifest: ExamplesManifest = {
      version: "0.0.0",
      generatedAt: "",
      repoUrl: "",
      examples: [],
      categories: [],
      languages: [],
    };
    expect(manifest.examples).toHaveLength(0);
    expect(manifest.categories).toHaveLength(0);
    expect(manifest.languages).toHaveLength(0);
  });
});

describe("CreateOptions type", () => {
  test("empty options", () => {
    const opts: CreateOptions = {};
    expect(opts.language).toBeUndefined();
    expect(opts.example).toBeUndefined();
    expect(opts.yes).toBeUndefined();
  });

  test("fully specified options", () => {
    const opts: CreateOptions = {
      language: "typescript",
      example: "basic",
      yes: true,
    };
    expect(opts.language).toBe("typescript");
    expect(opts.example).toBe("basic");
    expect(opts.yes).toBe(true);
  });
});

describe("InfoOptions type", () => {
  test("empty options", () => {
    const opts: InfoOptions = {};
    expect(opts.language).toBeUndefined();
    expect(opts.json).toBeUndefined();
  });

  test("fully specified options", () => {
    const opts: InfoOptions = {
      language: "python",
      json: true,
    };
    expect(opts.language).toBe("python");
    expect(opts.json).toBe(true);
  });
});
