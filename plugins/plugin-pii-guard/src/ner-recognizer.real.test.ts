/**
 * REAL integration test: actually loads `dslim/distilbert-NER` via transformers.js
 * (`onnxruntime-node`, native CPU) and runs it on a sentence. Excluded from the
 * default vitest run (see vitest.config.ts) and skips gracefully when the model
 * cannot be downloaded (offline / sandboxed CI), so it never turns the suite red
 * in a no-network environment.
 *
 * Run explicitly:
 *   bunx vitest run src/ner-recognizer.real.test.ts \
 *     --config <(echo 'export default { test: { include: ["src/ner-recognizer.real.test.ts"] } }')
 * or (simpler) point vitest at this file with the exclude patterns overridden.
 */

import type { EntitySpan } from "@elizaos/core";
import { beforeAll, describe, expect, it } from "vitest";
import { NerEntityRecognizer } from "./ner-recognizer.js";

const SENTENCE = "Email Dana Whitfield at Northwind Labs in Fairhaven.";
// Generous — first run downloads ~250MB of model weights + tokenizer.
const LOAD_TIMEOUT_MS = 300_000;

describe("NerEntityRecognizer — REAL dslim/distilbert-NER", () => {
  let recognizer: NerEntityRecognizer | null = null;
  let loadError: unknown = null;

  beforeAll(async () => {
    const rec = new NerEntityRecognizer();
    try {
      const classifier = await rec.load();
      if (!classifier) {
        loadError = new Error("model load returned null (see plugin logs)");
        return;
      }
      recognizer = rec;
    } catch (error) {
      loadError = error;
    }
  }, LOAD_TIMEOUT_MS);

  it(
    "detects a person and an organization in the sentence",
    async () => {
      if (!recognizer) {
        // Offline / download blocked — skip rather than fail the suite.
        console.warn(
          `[pii-guard.real] SKIPPED — could not load dslim/distilbert-NER: ${
            loadError instanceof Error ? loadError.message : String(loadError)
          }`,
        );
        return;
      }

      const spans: EntitySpan[] = await recognizer.recognize(SENTENCE);
      console.log(
        "[pii-guard.real] detected entities:",
        JSON.stringify(spans, null, 2),
      );

      const kinds = new Set(spans.map((s) => s.kind));
      expect(kinds.has("person")).toBe(true);
      expect(kinds.has("org")).toBe(true);

      // Every emitted value must be an exact slice of the source text.
      for (const span of spans) {
        expect(SENTENCE.slice(span.start, span.end)).toBe(span.value);
        expect(span.score ?? 0).toBeGreaterThanOrEqual(0.5);
      }

      const person = spans.find((s) => s.kind === "person");
      expect(person?.value).toContain("Dana");
      const org = spans.find((s) => s.kind === "org");
      expect(org?.value).toContain("Northwind");
    },
    LOAD_TIMEOUT_MS,
  );
});
