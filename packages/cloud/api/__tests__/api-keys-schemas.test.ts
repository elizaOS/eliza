/**
 * Pins the v1 api-keys request-schema wire contract (create + update) at the
 * validation boundary of POST /api/v1/api-keys and PATCH /api/v1/api-keys/:id,
 * whose routes destructure the parsed output directly (create shape is pinned
 * as contract [K07] in packages/cloud/shared/docs/billing-contract-matrix.md).
 * Deterministic direct-schema harness: real exported Zod schemas, real inputs,
 * no mocks. The asserted transform outputs — the Date object for expires_at,
 * trim-to-null description, coerced/defaulted rate_limit, and the
 * undefined/null/string field states — are the values the routes pass to
 * apiKeysService.
 */

import { describe, expect, test } from "bun:test";
import { createApiKeySchema, updateApiKeySchema } from "../v1/api-keys/schemas";

describe("createApiKeySchema", () => {
  test("parses a full request and returns a Date instance for expires_at", () => {
    const parsed = createApiKeySchema.parse({
      name: "prod-key",
      description: "  prod deploy key  ",
      rate_limit: 250,
      expires_at: "2030-01-15T00:00:00.000Z",
    });

    expect(parsed.name).toBe("prod-key");
    expect(parsed.description).toBe("prod deploy key");
    expect(parsed.rate_limit).toBe(250);
    expect(parsed.expires_at).toEqual(new Date("2030-01-15T00:00:00.000Z"));
  });

  test("requires name and rejects missing/empty/whitespace names", () => {
    expect(createApiKeySchema.safeParse({}).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: "" }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: "   " }).success).toBe(false);
  });

  test("caps name at 100 characters", () => {
    const tooLong = "a".repeat(101);
    expect(createApiKeySchema.safeParse({ name: tooLong }).success).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: "a".repeat(100) }).success,
    ).toBe(true);
  });

  test("collapses a whitespace-only description to null, not undefined", () => {
    const parsed = createApiKeySchema.parse({ name: "k", description: "   " });
    expect(parsed.description).toBe(null);
    expect("description" in parsed).toBe(true);
  });

  test("keeps a null description as null and passes omitted description through as null", () => {
    expect(
      createApiKeySchema.parse({ name: "k", description: null }).description,
    ).toBe(null);
    // create normalizes an omitted description to null so apiKeysService.create
    // always receives an explicit value for the column.
    expect(createApiKeySchema.parse({ name: "k" }).description).toBe(null);
  });

  test("coerces a numeric-string rate_limit and defaults to 1000 when omitted", () => {
    expect(
      createApiKeySchema.parse({ name: "k", rate_limit: "150" }).rate_limit,
    ).toBe(150);
    expect(createApiKeySchema.parse({ name: "k" }).rate_limit).toBe(1000);
  });

  test("accepts rate_limit at the exact bounds 1 and 100000", () => {
    expect(
      createApiKeySchema.parse({ name: "k", rate_limit: 1 }).rate_limit,
    ).toBe(1);
    expect(
      createApiKeySchema.parse({ name: "k", rate_limit: 100000 }).rate_limit,
    ).toBe(100000);
  });

  test("trims surrounding whitespace from name", () => {
    expect(createApiKeySchema.parse({ name: "  padded  " }).name).toBe(
      "padded",
    );
  });

  test("rejects non-integer and out-of-range rate_limit values", () => {
    expect(
      createApiKeySchema.safeParse({ name: "k", rate_limit: 0 }).success,
    ).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: "k", rate_limit: 100001 }).success,
    ).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: "k", rate_limit: 12.5 }).success,
    ).toBe(false);
  });

  test("accepts expires_at null and passes it through as null", () => {
    const parsed = createApiKeySchema.parse({ name: "k", expires_at: null });
    expect(parsed.expires_at).toBe(null);
  });

  test("rejects non-date strings for expires_at, including whitespace-only", () => {
    expect(
      createApiKeySchema.safeParse({ name: "k", expires_at: "not-a-date" })
        .success,
    ).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: "k", expires_at: "   " }).success,
    ).toBe(false);
  });
});

describe("updateApiKeySchema", () => {
  test("requires at least one field — an empty PATCH body is rejected", () => {
    const result = updateApiKeySchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) => i.message === "At least one field is required",
        ),
      ).toBe(true);
    }
  });

  test("preserves the three-state description contract: omitted → undefined, null → null, trimmed string → string", () => {
    // omitted: the update route spreads {...(description !== undefined && ...)},
    // so undefined means "leave the stored description untouched".
    const omitted = updateApiKeySchema.parse({ name: "n" });
    expect(omitted.description).toBeUndefined();

    const cleared = updateApiKeySchema.parse({ description: null });
    expect(cleared.description).toBe(null);

    const set = updateApiKeySchema.parse({ description: "  new text  " });
    expect(set.description).toBe("new text");
  });

  test("whitespace-only description clears to null on update, not empty string", () => {
    const parsed = updateApiKeySchema.parse({ description: "   " });
    expect(parsed.description).toBe(null);
  });

  test("applies name constraints only when name is provided", () => {
    expect(updateApiKeySchema.safeParse({ name: "" }).success).toBe(false);
    expect(updateApiKeySchema.safeParse({ name: "valid" }).success).toBe(true);
    expect(
      updateApiKeySchema.safeParse({ name: "a".repeat(101) }).success,
    ).toBe(false);
  });

  test("coerces numeric-string rate_limit within bounds", () => {
    const parsed = updateApiKeySchema.parse({ rate_limit: "75" });
    expect(parsed.rate_limit).toBe(75);
    expect(updateApiKeySchema.safeParse({ rate_limit: 0 }).success).toBe(false);
    expect(updateApiKeySchema.safeParse({ rate_limit: 100001 }).success).toBe(
      false,
    );
  });

  test("keeps is_active strictly boolean — numeric 1/0 are rejected", () => {
    expect(updateApiKeySchema.parse({ is_active: false }).is_active).toBe(
      false,
    );
    expect(updateApiKeySchema.safeParse({ is_active: 1 }).success).toBe(false);
    expect(updateApiKeySchema.safeParse({ is_active: 0 }).success).toBe(false);
  });

  test("keeps an omitted expires_at as absent on update — distinct from explicit null", () => {
    const omitted = updateApiKeySchema.parse({ name: "n" });
    expect(omitted.expires_at).toBeUndefined();
    expect("expires_at" in omitted).toBe(false);
  });

  test("rejects boolean rate_limit at the wire boundary while accepting numeric input", () => {
    // Booleans are a client typo, not a quota: z.coerce.number() would silently
    // map `true` to quota 1 (and `false` to an out-of-bounds 0). The wire
    // contract is numeric 1-100000 [K07]; numeric strings still coerce.
    expect(
      createApiKeySchema.safeParse({ name: "k", rate_limit: true }).success,
    ).toBe(false);
    expect(
      createApiKeySchema.safeParse({ name: "k", rate_limit: false }).success,
    ).toBe(false);
    expect(updateApiKeySchema.safeParse({ rate_limit: true }).success).toBe(
      false,
    );
    expect(updateApiKeySchema.safeParse({ rate_limit: false }).success).toBe(
      false,
    );

    // positive controls: real numeric quotas and numeric strings still pass
    expect(
      createApiKeySchema.parse({ name: "k", rate_limit: 250 }).rate_limit,
    ).toBe(250);
    expect(
      createApiKeySchema.parse({ name: "k", rate_limit: "150" }).rate_limit,
    ).toBe(150);
    expect(updateApiKeySchema.parse({ rate_limit: "75" }).rate_limit).toBe(75);
  });

  test("transforms a valid expires_at to a Date and rejects invalid ones on update", () => {
    const parsed = updateApiKeySchema.parse({
      expires_at: "2029-06-30T12:00:00.000Z",
    });
    expect(parsed.expires_at).toEqual(new Date("2029-06-30T12:00:00.000Z"));

    expect(updateApiKeySchema.safeParse({ expires_at: "junk" }).success).toBe(
      false,
    );
    // null is the explicit "clear expiry" update and must stay accepted
    const cleared = updateApiKeySchema.parse({ expires_at: null });
    expect(cleared.expires_at).toBe(null);
  });

  test("strips unknown keys rather than rejecting them (a known-field body still parses)", () => {
    // z.object() strips unknown keys; an unknown-only body fails only because
    // stripping leaves {} which trips the at-least-one-field refinement.
    const unknownOnly = updateApiKeySchema.safeParse({ unknown_field: "x" });
    expect(unknownOnly.success).toBe(false);
    if (!unknownOnly.success) {
      expect(
        unknownOnly.error.issues.some(
          (i) => i.message === "At least one field is required",
        ),
      ).toBe(true);
    }
    const withKnown = updateApiKeySchema.parse({
      name: "valid",
      unknown_field: "x",
    });
    expect(withKnown.name).toBe("valid");
    expect("unknown_field" in withKnown).toBe(false);
  });
});
