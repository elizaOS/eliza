import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, "..");
const SRC_INDEX = join(PACKAGE_ROOT, "src", "index.ts");
const SPECS_DIR = join(PACKAGE_ROOT, "specs");
const SCRIPTS_DIR = join(PACKAGE_ROOT, "scripts");

function readSrc() {
  return readFileSync(SRC_INDEX, "utf-8");
}

function extractTemplateConsts(source) {
  const re = /export const ([a-z][a-zA-Z0-9]*Template)\b/g;
  const names = new Set();
  for (const m of source.matchAll(re)) names.add(m[1]);
  return [...names];
}

describe("prompt templates (src/index.ts)", () => {
  it("src/index.ts exists", () => {
    assert.ok(existsSync(SRC_INDEX), "src/index.ts should exist");
  });

  it("exports at least one camelCaseTemplate constant", () => {
    const names = extractTemplateConsts(readSrc());
    assert.ok(
      names.length > 0,
      "Should export at least one camelCaseTemplate constant",
    );
  });

  it("template names follow camelCaseTemplate convention", () => {
    const names = extractTemplateConsts(readSrc());
    for (const name of names) {
      assert.match(
        name,
        /^[a-z][a-zA-Z0-9]*Template$/,
        `${name} should follow camelCaseTemplate convention`,
      );
    }
  });

  it("each camelCaseTemplate has a paired UPPER_SNAKE_CASE_TEMPLATE re-export", () => {
    const src = readSrc();
    const names = extractTemplateConsts(src);
    for (const name of names) {
      // camelCase → UPPER_SNAKE_CASE
      const upper = name
        .replace(/Template$/, "")
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase()
        .replace(/^_/, "");
      const constName = `${upper}_TEMPLATE`;
      assert.ok(
        new RegExp(`export const ${constName}\\b`).test(src) ||
          new RegExp(`export\\s*\\{[^}]*\\b${constName}\\b`).test(src),
        `Missing UPPER_SNAKE_CASE_TEMPLATE re-export for ${name} (expected ${constName})`,
      );
    }
  });

  it("known required templates exist", () => {
    const required = [
      "messageHandlerTemplate",
      "replyTemplate",
      "shouldRespondTemplate",
    ];
    const names = new Set(extractTemplateConsts(readSrc()));
    for (const r of required) {
      assert.ok(names.has(r), `Required template "${r}" should be exported`);
    }
  });

  it("templates have balanced Handlebars delimiters", () => {
    const src = readSrc();
    const opens = (src.match(/\{\{/g) || []).length;
    const closes = (src.match(/\}\}/g) || []).length;
    assert.strictEqual(
      opens,
      closes,
      `src/index.ts has unbalanced delimiters: ${opens} {{ vs ${closes} }}`,
    );
  });
});

describe("build scripts", () => {
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
});
