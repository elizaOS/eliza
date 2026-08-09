/**
 * Runs the text-model wire-contract shape matrix together for changes that
 * cross `models/text.ts` — request normalization (messages, tools, schemas),
 * transient-error classification, and provider-error enrichment. Suites that
 * `vi.mock("ai")` (native-plumbing, stream-start-retry, streamstructured)
 * cannot compose into one file — their module mocks are file-scoped and
 * collide — so they stay standalone.
 */
import { expect, it } from "vitest";
import "./cerebras-tool-strictness.shape.test.ts";
import "./provider-error-enrichment.shape.test.ts";
import "./record-args-observability.shape.test.ts";
import "./sanitize-json-schema.shape.test.ts";
import "./tool-message-pairing.shape.test.ts";
import "./tool-pairing-transient-400.shape.test.ts";
import "./wire-well-formed.shape.test.ts";
import { __INTERNAL_normalizeNativeMessages } from "../models/text.ts";

it("loads the text wire-contract regression matrix", () => {
  expect(typeof __INTERNAL_normalizeNativeMessages).toBe("function");
});
