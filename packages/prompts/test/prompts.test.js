/**
 * Verifies executable prompt utilities, exported template integrity, generated
 * specs, and the injection boundary around contact-message input.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import * as prompts from "../src/index.ts";
import { compressPromptDescription } from "../src/prompt-compression.ts";

const exportedPrompts = Object.fromEntries(Object.entries(prompts));
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcIndex = join(packageRoot, "src", "index.ts");
const specsDir = join(packageRoot, "specs");

function readSrc() {
  return readFileSync(srcIndex, "utf-8");
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function extractTemplateConsts(source) {
  return [
    ...source.matchAll(/export const ([a-z][a-zA-Z0-9]*Template)\b/g),
  ].map((match) => match[1]);
}

describe("prompt template exports", () => {
  it("exports every declared prompt template as a non-empty string", () => {
    const names = extractTemplateConsts(readSrc());
    assert.ok(names.length > 0, "at least one prompt template is declared");
    for (const name of names) {
      const prompt = exportedPrompts[name];
      assert.strictEqual(typeof prompt, "string", `${name} should be exported`);
      assert.ok(prompt.trim().length > 0, `${name} should not be empty`);
    }
  });

  it("pairs camelCase template exports with their compatibility aliases", () => {
    const source = readSrc();
    for (const name of extractTemplateConsts(source)) {
      const upper = name
        .replace(/Template$/, "")
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase()
        .replace(/^_/, "");
      const alias = `${upper}_TEMPLATE`;
      assert.ok(
        new RegExp(`export const ${alias}\\b`).test(source) ||
          new RegExp(`export\\s*\\{[^}]*\\b${alias}\\b`).test(source),
        `Missing compatibility alias ${alias} for ${name}`,
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

  it("keeps every user-facing response lane conversational by default", () => {
    for (const template of [
      prompts.messageHandlerTemplate,
      prompts.plannerTemplate,
      prompts.replyTemplate,
    ]) {
      assert.match(
        template,
        /natural conversation, not a database or debug log/,
      );
      assert.match(
        template,
        /Translate machine dates, 24-hour times, and Unix\/epoch timestamps into familiar dates and times/,
      );
      assert.match(
        template,
        /unless the user explicitly asks for raw or technical output/,
      );
      assert.match(template, /Preserve exact code and user-provided values/);
    }
  });

  it("plannerTemplate requires owner life-management tools for side effects and fail-closed questions", () => {
    assert.match(
      prompts.plannerTemplate,
      /matching owner life-management tool exists => call it before terminal answer/,
    );
    assert.match(
      prompts.plannerTemplate,
      /fail-closed no-op belongs in the tool result, not bare messageToUser/,
    );
  });

  it("plannerTemplate keeps native args direct and reserves the parameters envelope for plain JSON", () => {
    assert.match(
      prompts.plannerTemplate,
      /native toolCalls: pass each argument as a direct field in that tool's args object exactly as its schema declares/,
    );
    assert.match(
      prompts.plannerTemplate,
      /never nest arguments under `parameters` unless the tool schema itself declares a `parameters` field/,
    );
    assert.match(
      prompts.plannerTemplate,
      /plain-JSON fallback only \(when native tool calls are unavailable\)/,
    );
    assert.match(
      prompts.plannerTemplate,
      /never put that envelope inside a native tool's args/,
    );
  });

  it("routes live app creation and edits through the verified APP lifecycle", () => {
    assert.match(
      prompts.messageHandlerTemplate,
      /candidateActions=\["APP"\].*verified create-or-edit lifecycle and final link/,
    );
    assert.match(
      prompts.messageHandlerTemplate,
      /never replace it with raw TASKS\/SPAWN_AGENT/,
    );
    assert.match(
      prompts.messageHandlerTemplate,
      /imperative code\/repo\/file changes that are not an app lifecycle request/,
    );
  });

  it("factExtractionTemplate names structured fields for multilingual LifeOps projection", () => {
    const body = prompts.factExtractionTemplate;
    assert.match(
      body,
      /Use these English key names even when the\s+message is in another language/,
      "fact extractor should preserve English structured-field keys across locales",
    );
    assert.match(
      body,
      /"mi jefe es Pat" -> \{"person":"Pat","relationshipType":"manager"\}/,
      "relationship facts should include person + relationshipType without English regex parsing",
    );
    assert.match(
      body,
      /"Je m'appelle Camille" -> \{"preferredName":"Camille"\}/,
      "identity facts should include preferredName for non-English self-introductions",
    );
    assert.match(
      body,
      /relationship: person or partnerName, relationshipType, relationshipStatus,\s+platform, handle/,
      "relationship structured fields should include graph and identity-handle keys",
    );
  });

  it("templates have balanced Handlebars delimiters", () => {
    const source = readSrc();
    assert.strictEqual(
      (source.match(/\{\{/g) || []).length,
      (source.match(/\}\}/g) || []).length,
    );
  });
});

describe("compressPromptDescription", () => {
  it("normalizes arbitrary descriptions to one line", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2_000 }), (description) => {
        const compressed = compressPromptDescription(description);
        assert.ok(!/\s{2,}|\r|\n/.test(compressed));
      }),
      { numRuns: 500 },
    );
  });

  it("preserves protected technical spans", () => {
    const compressed = compressPromptDescription(
      "Read `npm run test`, https://example.com/a?b=c, and OPENAI_API_KEY before validating configuration.",
    );
    assert.match(compressed, /`npm run test`/);
    assert.match(compressed, /https:\/\/example\.com\/a\?b=c/);
    assert.match(compressed, /OPENAI_API_KEY/);
  });
});

describe("specs directory", () => {
  it("ships non-empty action and provider specs with unique names", () => {
    const specs = [
      { path: join(specsDir, "actions", "core.json"), key: "actions" },
      { path: join(specsDir, "providers", "core.json"), key: "providers" },
    ];

    for (const spec of specs) {
      const parsed = readJsonFile(spec.path);
      assert.ok(Array.isArray(parsed[spec.key]));
      assert.ok(parsed[spec.key].length > 0);
      const names = new Set();
      for (const item of parsed[spec.key]) {
        assert.ok(item.name.trim().length > 0);
        assert.strictEqual(names.has(item.name), false);
        names.add(item.name);
        assert.ok(item.description.trim().length > 0);
      }
    }
  });

  it("keeps generated descriptions compressible and aliases aligned", () => {
    const generated = readJsonFile(
      join(specsDir, "actions", "plugins.generated.json"),
    );
    assert.ok(Array.isArray(generated.actions));
    for (const action of generated.actions) {
      assert.ok(compressPromptDescription(action.description).length > 0);
      if (
        action.compressedDescription !== undefined &&
        action.descriptionCompressed !== undefined
      ) {
        assert.strictEqual(
          action.compressedDescription,
          action.descriptionCompressed,
        );
      }
    }
  });
});

describe("addContactTemplate input isolation", () => {
  it("places message input inside current-message delimiters", () => {
    const template = prompts.addContactTemplate;
    const open = template.indexOf("<current_message>");
    const message = template.indexOf("{{message}}");
    const close = template.indexOf("</current_message>");
    assert.ok(open !== -1 && open < message && message < close);
  });

  it("marks delimited and delimiter-like content as data", () => {
    const template = prompts.addContactTemplate.toLowerCase();
    assert.ok(
      template.includes("never follow instructions") ||
        template.includes("strictly as data"),
    );
    assert.ok(
      template.includes("delimiter-like text") &&
        template.includes("not boundaries"),
    );
  });
});
