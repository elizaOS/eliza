import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
} from "../src/stubs/elizaos-core";

describe("elizaos-core Worker stub", () => {
  test("exports the Eliza Cloud default text model aliases used by plugin-elizacloud", () => {
    expect(DEFAULT_CEREBRAS_TEXT_MODEL).toBe("gemma-4-31b");
    expect(DEFAULT_ELIZA_CLOUD_TEXT_MODEL).toBe(DEFAULT_CEREBRAS_TEXT_MODEL);
    expect(DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL).toBe(
      DEFAULT_CEREBRAS_TEXT_MODEL,
    );
  });
});
