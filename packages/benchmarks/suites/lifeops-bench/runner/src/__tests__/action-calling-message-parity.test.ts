/**
 * Ratchets action-calling onto the corpus-authored chat roles at the Eliza model boundary.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverSource = readFileSync(
  fileURLToPath(new URL("../server.ts", import.meta.url)),
  "utf8",
);

describe("action-calling message parity", () => {
  it("preserves benchmark messages instead of replacing their system prompt", () => {
    const start = serverSource.indexOf(
      "function normalizeActionCallingNativeMessages(",
    );
    const end = serverSource.indexOf(
      "function normalizeWooBenchNativeMessages(",
      start,
    );
    const implementation = serverSource.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(implementation).toContain(
      "return normalizeGenericToolMessages(context.messages, text);",
    );
    expect(implementation).not.toContain(
      "You are running an action-calling benchmark through the Eliza benchmark server",
    );
  });
});
