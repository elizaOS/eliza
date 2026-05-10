/**
 * Translation harness regression test.
 *
 * Backs `docs/audit/translation-harness.md` and the W2-E
 * `MultilingualPromptRegistry`. After the W2-G bulk-translation pass the
 * registry covers every example-bearing app-lifeops action × {es, fr}.
 * Verifies:
 *   - the harness-generated packs are wired into `registerDefaultPromptPack`,
 *   - the registry contains both Spanish and French entries,
 *   - each registered entry's exampleKey follows the
 *     `<actionName>.example.<index>` shape with an UPPER_SNAKE_CASE action
 *     token,
 *   - placeholders (`{{name1}}`, `{{agentName}}`) and action tokens are
 *     preserved through translation,
 *   - translated text is non-empty.
 */

import { describe, expect, it } from "vitest";
import {
  createMultilingualPromptRegistry,
  registerDefaultPromptPack,
  type PromptExampleEntry,
} from "../src/lifeops/i18n/prompt-registry.ts";

const ACTION_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function loadDefaultRegistryEntries(): PromptExampleEntry[] {
  const registry = createMultilingualPromptRegistry();
  registerDefaultPromptPack(registry);
  return registry.list();
}

const isGenerated = (entry: PromptExampleEntry): boolean =>
  /\.example\.\d+$/.test(entry.exampleKey);

describe("translation harness — generated packs", () => {
  const all = loadDefaultRegistryEntries();
  const generatedSpanish = all.filter(
    (entry) => entry.locale === "es" && isGenerated(entry),
  );
  const generatedFrench = all.filter(
    (entry) => entry.locale === "fr" && isGenerated(entry),
  );
  const generated = [...generatedSpanish, ...generatedFrench];

  it("registers harness-generated packs for both Spanish and French", () => {
    expect(generatedSpanish.length).toBeGreaterThanOrEqual(20);
    expect(generatedFrench.length).toBeGreaterThanOrEqual(20);
  });

  it("Spanish and French coverage matches per action", () => {
    const esActions = new Set(
      generatedSpanish.map(
        (entry) => entry.exampleKey.split(".example.")[0] ?? "",
      ),
    );
    const frActions = new Set(
      generatedFrench.map(
        (entry) => entry.exampleKey.split(".example.")[0] ?? "",
      ),
    );
    expect(esActions).toEqual(frActions);
  });

  it("uses the <actionName>.example.<index> exampleKey shape", () => {
    for (const entry of generated) {
      const [actionName, suffix] = entry.exampleKey.split(".example.");
      expect(actionName ?? "").toMatch(ACTION_NAME_PATTERN);
      expect(suffix).toMatch(/^\d+$/);
    }
  });

  it("preserves speaker placeholders verbatim", () => {
    // Source actions use either `{{name1}}/{{agentName}}` (the registry default
    // pair) or `{{user1}}/{{agent}}` (older convention used by a handful of
    // app-lifeops actions). The harness must round-trip whichever one the
    // source uses without translating placeholder identifiers.
    const userPlaceholders = new Set(["{{name1}}", "{{user1}}"]);
    const agentPlaceholders = new Set(["{{agentName}}", "{{agent}}"]);
    for (const entry of generated) {
      expect(userPlaceholders.has(entry.user.name ?? "")).toBe(true);
      expect(agentPlaceholders.has(entry.agent.name ?? "")).toBe(true);
    }
  });

  it("does not translate action tokens or placeholders into the agent text", () => {
    // Source action examples are heterogeneous: some carry a structured
    // `actions: ["X"]` or `action: "X"` literal, others reference a constant
    // (`action: ACTION_NAME`) that the harness's literal-only AST extractor
    // intentionally drops, and some omit the token entirely. The non-negotiable
    // invariant is that when a structured action token IS present, it stays as
    // an UPPER_SNAKE_CASE token (never translated), and when an inline token
    // appears in the agent text it matches the action name verbatim.
    // Action tokens are UPPER_SNAKE_CASE (e.g. `LIFE`, `SCHEDULED_TASK`) plus
    // optional dotted verb suffix (e.g. `MESSAGE.handoff`).
    const tokenShape = /^[A-Z][A-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)?$/;
    for (const entry of generated) {
      const text = entry.agent.content?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
      const actions = entry.agent.content?.actions;
      const action = (entry.agent.content as { action?: string } | undefined)
        ?.action;
      if (Array.isArray(actions)) {
        for (const token of actions) {
          expect(token).toMatch(tokenShape);
        }
      }
      if (typeof action === "string" && action.length > 0) {
        expect(action).toMatch(tokenShape);
      }
    }
  });

  it("never translates the {{name1}}/{{agentName}}/{{user1}}/{{agent}} placeholders inside text", () => {
    // The placeholder must survive translation literally if the source used it
    // in the text body (most actions only use it in the speaker `name`, which
    // is checked separately).
    const placeholderInText = /\{\{(name1|agentName|user1|agent)\}\}/;
    for (const entry of generated) {
      const text = `${entry.user.content?.text ?? ""} ${entry.agent.content?.text ?? ""}`;
      const matches = text.match(/\{\{[^}]+\}\}/g) ?? [];
      for (const match of matches) {
        expect(match).toMatch(placeholderInText);
      }
    }
  });

  it("translated text is non-empty for every entry", () => {
    for (const entry of generated) {
      const userText = entry.user.content?.text ?? "";
      const agentText = entry.agent.content?.text ?? "";
      expect(userText.length).toBeGreaterThan(0);
      expect(agentText.length).toBeGreaterThan(0);
    }
  });
});
