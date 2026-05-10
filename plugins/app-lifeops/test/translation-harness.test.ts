/**
 * Translation harness regression test.
 *
 * Backs `docs/audit/translation-harness.md` and the W2-E
 * `MultilingualPromptRegistry`. Verifies:
 *   - the harness-generated Spanish packs are wired into
 *     `registerDefaultPromptPack`,
 *   - the registry contains ≥ 3 Spanish translations from the 3-action
 *     proof-of-concept (LIFE, MESSAGE_HANDOFF, SCHEDULED_TASK),
 *   - each registered Spanish entry's exampleKey follows the
 *     `<actionName>.example.<index>` shape and references a known action,
 *   - placeholders (`{{name1}}`, `{{agentName}}`) and action tokens are
 *     preserved through translation.
 */

import { describe, expect, it } from "vitest";
import {
  createMultilingualPromptRegistry,
  registerDefaultPromptPack,
  type PromptExampleEntry,
} from "../src/lifeops/i18n/prompt-registry.ts";

const KNOWN_ACTION_NAMES = new Set([
  "LIFE",
  "MESSAGE_HANDOFF",
  "SCHEDULED_TASK",
]);

const ACTION_TOKEN_PATTERN = /\b(LIFE|MESSAGE\.handoff|SCHEDULED_TASK)\b/;

function loadDefaultRegistryEntries(): PromptExampleEntry[] {
  const registry = createMultilingualPromptRegistry();
  registerDefaultPromptPack(registry);
  return registry.list();
}

describe("translation harness — generated Spanish packs", () => {
  const all = loadDefaultRegistryEntries();
  const spanish = all.filter((entry) => entry.locale === "es");
  const generatedSpanish = spanish.filter((entry) =>
    /\.example\.\d+$/.test(entry.exampleKey),
  );

  it("registers at least 3 Spanish translations from the harness", () => {
    expect(generatedSpanish.length).toBeGreaterThanOrEqual(3);
  });

  it("covers all 3 sample actions (LIFE, MESSAGE_HANDOFF, SCHEDULED_TASK)", () => {
    const actionsCovered = new Set(
      generatedSpanish.map(
        (entry) => entry.exampleKey.split(".example.")[0] ?? "",
      ),
    );
    expect(actionsCovered).toEqual(KNOWN_ACTION_NAMES);
  });

  it("uses the <actionName>.example.<index> exampleKey shape", () => {
    for (const entry of generatedSpanish) {
      const [actionName, suffix] = entry.exampleKey.split(".example.");
      expect(KNOWN_ACTION_NAMES.has(actionName ?? "")).toBe(true);
      expect(suffix).toMatch(/^\d+$/);
    }
  });

  it("preserves speaker placeholders verbatim", () => {
    for (const entry of generatedSpanish) {
      expect(entry.user.name).toBe("{{name1}}");
      expect(entry.agent.name).toBe("{{agentName}}");
    }
  });

  it("preserves action tokens in agent replies", () => {
    for (const entry of generatedSpanish) {
      const text = entry.agent.content?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
      const actions = entry.agent.content?.actions;
      const action = (entry.agent.content as { action?: string } | undefined)
        ?.action;
      // Either a structured `actions[]` / `action` or an inline token in the
      // text. The harness preserves whichever the source action used.
      const hasStructured =
        (Array.isArray(actions) && actions.length > 0) ||
        (typeof action === "string" && action.length > 0);
      const hasInline = ACTION_TOKEN_PATTERN.test(text);
      expect(hasStructured || hasInline).toBe(true);
    }
  });

  it("translated text is non-empty and visibly Spanish-leaning", () => {
    // Crude sanity check: the user-facing text contains at least one
    // common Spanish letter pattern (´/¿/¡/ñ/é/í/ó/ú) OR a clearly
    // Spanish-only short word ("para", "que", "para que", "los", "el").
    const spanishHint =
      /[¿¡ñáéíóúÁÉÍÓÚÑ]|\b(para|que|los|las|del|por|con|cuando|hoy|mañana|recordatorio|tarea|seguimientos|agente|vuelve|reanudado|reanudar|posponer|completada)\b/i;
    for (const entry of generatedSpanish) {
      const userText = entry.user.content?.text ?? "";
      const agentText = entry.agent.content?.text ?? "";
      expect(userText.length).toBeGreaterThan(0);
      expect(agentText.length).toBeGreaterThan(0);
      expect(spanishHint.test(`${userText} ${agentText}`)).toBe(true);
    }
  });
});
