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

  it("messageHandlerTemplate forbids phantom action claims in replyText", () => {
    // Regression coverage for the structural rule that prevents Stage 1
    // from writing "I scanned/searched/checked/looked up/recalled/remembered"
    // prose when no tool call this turn actually retrieved that content.
    // Originally observed in production as the bot replying "I've scanned
    // the recent chat..." with plannerIterations=0 and toolCallsExecuted=0.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const match = src.match(messageHandlerTemplateRe);
    assert.ok(
      match,
      "messageHandlerTemplate string literal should be findable",
    );
    const body = match[1];
    assert.match(
      body,
      /Never write replyText that claims you have searched, scanned, checked, looked up, recalled, or remembered anything/,
      "messageHandlerTemplate should carry the phantom-action-claim rule",
    );
    assert.match(
      body,
      /unless an actual tool call this turn returned that content/,
      "phantom-action-claim rule should bind the prohibition to actual tool execution this turn",
    );
  });

  it("messageHandlerTemplate routes visible attachment references through ATTACHMENT and ignores generic verbs in unrelated questions", () => {
    // Regression coverage for the structural rule that replaced the
    // regex-list-based attachment-inspection evaluator. Without this rule
    // Stage 1 used to be hijacked by a post-Stage-1 evaluator whose
    // VISUAL_INSPECTION_RE matched any use of "read"/"view"/"describe"/
    // "analyze"/"inspect"/"open" whenever any attachment lingered in state,
    // turning normal dev questions like "how do I read a file in node?" into
    // 2 MB / $0.09 / 3-iteration planner trajectories.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const body = src.match(messageHandlerTemplateRe)[1];
    assert.match(
      body,
      /provider:ATTACHMENTS/,
      "attachment rule should reference the ATTACHMENTS provider explicitly by name",
    );
    assert.match(
      body,
      /route through the ATTACHMENT action/,
      "attachment rule should direct routing through the ATTACHMENT action",
    );
    assert.match(
      body,
      /Generic verbs like "read", "view", "describe", "open" used in unrelated questions/,
      "attachment rule should disclaim generic-verb false positives",
    );
  });

  it("messageHandlerTemplate defaults to deferring high-stakes personal-crisis topics to qualified professionals", () => {
    // Default safety scaffold (#7925): when a user asks what someone should
    // do in a personal-crisis situation involving legal jeopardy, criminal
    // exposure, medical emergencies, self-harm, or active police/CPS
    // contact, the framework default is to acknowledge the stakes and
    // recommend qualified professional help instead of dispensing tactical
    // advice on concealing evidence, evading authorities, etc. Per-agent
    // character config may override.
    const src = readSrc();
    const messageHandlerTemplateRe =
      /export const messageHandlerTemplate = `([^`]+)`/;
    const body = src.match(messageHandlerTemplateRe)[1];
    assert.match(
      body,
      /personal-crisis situation involving legal jeopardy, criminal exposure/,
      "safety-scaffold rule should enumerate high-stakes topic categories",
    );
    assert.match(
      body,
      /do not give specific tactical advice on concealing evidence/,
      "safety-scaffold rule should forbid tactical concealment/evasion advice",
    );
    assert.match(
      body,
      /recommend qualified professional help/,
      "safety-scaffold rule should direct users to qualified counsel",
    );
    assert.match(
      body,
      /Per-agent character config may override/,
      "safety-scaffold rule should be opt-out-overridable at the agent layer",
    );
    // Stage 1 routing contract: the deferral is the complete reply (simple
    // path), no tools. Live trajectory tj-f7ab3f282747f6 showed that without
    // this clause Stage 1 set requiresTool=true and the planner spawned
    // BROWSER to fetch nolo.com / findlaw.com, all of which failed and the
    // user got no reply at all.
    assert.match(
      body,
      /The deferral itself is the complete reply for this turn/,
      "safety-scaffold rule should state the deferral is the complete reply",
    );
    assert.match(
      body,
      /use contexts=\["simple"\], put the deferral text in replyText/,
      "safety-scaffold rule should pin Stage 1 routing to simple path",
    );
    assert.match(
      body,
      /do NOT set requiresTool=true or hint candidateActions for these topics/,
      "safety-scaffold rule should forbid tool-spawning routing",
    );
    assert.match(
      body,
      /calling BROWSER to fetch nolo\.com \/ findlaw\.com/,
      "safety-scaffold rule should explicitly call out the failed-BROWSER-lookup anti-pattern",
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
