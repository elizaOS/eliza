/**
 * Deterministic coverage for the Worker-only PGlite replacement.
 * The real embedded database remains available to local tests; any accidental
 * Worker execution fails before opening a database.
 */

import { describe, expect, test } from "vitest";
import { btree_gist, PGlite, types, vector } from "./pglite";

const NOT_AVAILABLE =
  "PGlite is local-only and unavailable in the Cloudflare Worker runtime.";

describe("PGlite Worker stub", () => {
  test("rejects embedded database construction", () => {
    expect(() => new PGlite()).toThrowError(NOT_AVAILABLE);
  });

  test.each([vector, btree_gist])(
    "rejects local extension access",
    (extension) => {
      expect(extension).toThrowError(NOT_AVAILABLE);
    },
  );

  test("keeps the parser OIDs expected by drizzle-orm/pglite", () => {
    expect(types).toEqual({
      TIMESTAMP: 1114,
      TIMESTAMPTZ: 1184,
      INTERVAL: 1186,
      DATE: 1082,
    });
  });
});
