/** Verifies that the shared spoken-text API is the canonical core helper, not a behavioral twin. */
import { sanitizeSpeechText as coreSanitize } from "@elizaos/core/client-public";
import { expect, it } from "vitest";

import { sanitizeSpeechText as sharedSanitize } from "./spoken-text";

it("re-exports the canonical core spoken-text sanitizer", () => {
  expect(sharedSanitize).toBe(coreSanitize);
});
