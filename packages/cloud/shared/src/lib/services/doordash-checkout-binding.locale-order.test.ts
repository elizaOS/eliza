/**
 * Pins the managed DoorDash checkout binding digest to UTF-16 code-unit key
 * ordering. `assertManagedCheckoutBinding` is the guard that stops a cart or
 * price preview from changing between user confirmation and order placement, so
 * the digest must be a pure function of cart content. ICU collation makes it a
 * function of the host locale and of property insertion order as well, which
 * lets an unchanged cart fail the binding check after any JSON round-trip that
 * reorders keys.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  assertManagedCheckoutBinding,
  managedCheckoutBindingDigest,
} from "./doordash-checkout-binding";

const NFC_KEY = "caf\u00e9"; // precomposed U+00E9
const NFD_KEY = "cafe\u0301"; // decomposed "e" + U+0301

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("managed checkout binding canonical key order", () => {
  test("digests mixed-case cart keys in code-unit order, not locale order", () => {
    // ICU collation would serialize {"a":1,"B":2}; code-unit order is "B" (0x42)
    // before "a" (0x61). The expected wire string is pinned literally here rather
    // than recomputed, so the assertion fails if the sorter regresses.
    expect(managedCheckoutBindingDigest({ a: 1, B: 2 }, null)).toBe(
      sha256('{"cart":{"B":2,"a":1},"checkout":null}'),
    );
  });

  test("digests non-ASCII cart keys in code-unit order", () => {
    expect(managedCheckoutBindingDigest({ "\u00e4": 1, z: 2 }, null)).toBe(
      sha256('{"cart":{"z":2,"\u00e4":1},"checkout":null}'),
    );
  });

  test("an unchanged cart still binds after a key-reordering round-trip", () => {
    const digest = managedCheckoutBindingDigest(
      { items: [{ Qty: 2, name: "fries" }], storeId: "s-1", Tip: "1.00" },
      { Total: "9.99", subtotal: "8.99" },
    );
    expect(() =>
      assertManagedCheckoutBinding(
        digest,
        { Tip: "1.00", storeId: "s-1", items: [{ name: "fries", Qty: 2 }] },
        { subtotal: "8.99", Total: "9.99" },
      ),
    ).not.toThrow();
  });

  test("canonically equivalent distinct keys bind independent of insertion order", () => {
    expect(managedCheckoutBindingDigest({ [NFC_KEY]: 1, [NFD_KEY]: 2 }, null)).toBe(
      managedCheckoutBindingDigest({ [NFD_KEY]: 2, [NFC_KEY]: 1 }, null),
    );
  });

  test("a genuinely changed cart still fails the binding", () => {
    const digest = managedCheckoutBindingDigest({ storeId: "s-1", Tip: "1.00" }, null);
    expect(() =>
      assertManagedCheckoutBinding(digest, { storeId: "s-1", Tip: "5.00" }, null),
    ).toThrow("DoorDash cart or checkout changed after confirmation");
  });
});
