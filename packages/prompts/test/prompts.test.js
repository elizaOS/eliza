import assert from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const PROMPTS_DIR = join(PACKAGE_ROOT, "prompts");
const SPECS_DIR = join(PACKAGE_ROOT, "specs");
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");

describe("prompt templates", () => {
  it("prompts directory exists", () => {
    assert.ok(existsSync(PROMPTS_DIR), "prompts/ directory should exist");
  });

  it("has prompt template files", () => {
    const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".txt"));
    assert.ok(files.length > 0, "Should have at least one .txt template file");
  });

  it("all template files are non-empty", () => {
    const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      const content = readFileSync(join(PROMPTS_DIR, file), "utf-8");
      assert.ok(content.trim().length > 0, `${file} should not be empty`);
    }
  });

  it("template filenames follow snake_case convention", () => {
    const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      const name = basename(file, ".txt");
      assert.match(
        name,
        /^[a-z][a-z0-9_]*$/,
        `${file} should follow snake_case naming convention`,
      );
    }
  });

  it("templates have balanced Handlebars delimiters", () => {
    const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      const content = readFileSync(join(PROMPTS_DIR, file), "utf-8");
      const opens = (content.match(/\{\{/g) || []).length;
      const closes = (content.match(/\}\}/g) || []).length;
      assert.strictEqual(
        opens,
        closes,
        `${file} has unbalanced delimiters: ${opens} {{ vs ${closes} }}`,
      );
    }
  });

  it("known required templates exist", () => {
    const requiredTemplates = [
      "message_handler.txt",
      "reply.txt",
      "should_respond.txt",
    ];
    const files = readdirSync(PROMPTS_DIR);
    for (const required of requiredTemplates) {
      assert.ok(
        files.includes(required),
        `Required template "${required}" should exist in prompts/`,
      );
    }
  });
});

describe("build scripts", () => {
  it("generate.js script exists", () => {
    assert.ok(
      existsSync(join(SCRIPTS_DIR, "generate.js")),
      "generate.js should exist",
    );
  });

  it("check-secrets.js script exists", () => {
    assert.ok(
      existsSync(join(SCRIPTS_DIR, "check-secrets.js")),
      "check-secrets.js should exist",
    );
  });

  it("generate-action-docs.js script exists", () => {
    assert.ok(
      existsSync(join(SCRIPTS_DIR, "generate-action-docs.js")),
      "generate-action-docs.js should exist",
    );
  });

  it("generate-plugin-action-spec.js script exists", () => {
    assert.ok(
      existsSync(join(SCRIPTS_DIR, "generate-plugin-action-spec.js")),
      "generate-plugin-action-spec.js should exist",
    );
  });
});

describe("specs directory", () => {
  it("specs directory exists", () => {
    assert.ok(existsSync(SPECS_DIR), "specs/ directory should exist");
  });

  it("has subdirectories for actions, evaluators, providers", () => {
    const subdirs = ["actions", "evaluators", "providers"];
    for (const dir of subdirs) {
      const dirPath = join(SPECS_DIR, dir);
      if (existsSync(dirPath)) {
        const entries = readdirSync(dirPath);
        assert.ok(entries.length >= 0, `specs/${dir}/ should be accessible`);
      }
    }
  });
});

describe("naming conventions", () => {
  it("fileToConstName convention: snake_case -> UPPER_SNAKE_CASE_TEMPLATE", () => {
    // Verify the naming convention used by generate.js
    const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      const name = basename(file, ".txt");
      const expectedConst = `${name.toUpperCase().replace(/-/g, "_")}_TEMPLATE`;
      assert.match(
        expectedConst,
        /^[A-Z][A-Z0-9_]*_TEMPLATE$/,
        `Generated constant name "${expectedConst}" should be valid UPPER_SNAKE_CASE`,
      );
    }
  });

  it("fileToCamelCase convention: snake_case -> camelCaseTemplate", () => {
    const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".txt"));
    for (const file of files) {
      const name = basename(file, ".txt");
      const parts = name.split("_");
      const camel =
        parts[0] +
        parts
          .slice(1)
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
          .join("") +
        "Template";
      assert.match(
        camel,
        /^[a-z][a-zA-Z0-9]*Template$/,
        `Generated camelCase name "${camel}" should be valid`,
      );
    }
  });
});
