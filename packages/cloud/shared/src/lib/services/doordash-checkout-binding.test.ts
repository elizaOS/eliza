/**
 * Coverage for DoorDash checkout binding.
 */
import { describe, expect, it } from "vitest";

import {
  assertManagedCheckoutBinding,
  managedCheckoutBindingDigest,
} from "./doordash-checkout-binding.js";

describe("managedCheckoutBindingDigest", () => {
  it("is hex 64", () => {
    const d = managedCheckoutBindingDigest({ a: 1 }, { b: 2 });
    expect(d).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    const a = managedCheckoutBindingDigest({ x: 1, y: 2 }, { p: 3 });
    const b = managedCheckoutBindingDigest({ y: 2, x: 1 }, { p: 3 });
    expect(a).toBe(b);
  });

  it("differs for different cart", () => {
    const a = managedCheckoutBindingDigest({ a: 1 }, { b: 1 });
    const b = managedCheckoutBindingDigest({ a: 2 }, { b: 1 });
    expect(a).not.toBe(b);
  });
});

describe("assertManagedCheckoutBinding", () => {
  it("passes for correct digest", () => {
    const cart = { items: [1] };
    const preview = { total: 10 };
    const digest = managedCheckoutBindingDigest(cart, preview);
    expect(() => assertManagedCheckoutBinding(digest, cart, preview)).not.toThrow();
  });

  it("throws for wrong digest", () => {
    const cart = { a: 1 };
    const preview = { b: 1 };
    const bad = "a".repeat(64);
    expect(() => assertManagedCheckoutBinding(bad, cart, preview)).toThrow(
      /changed after confirmation/,
    );
  });

  it("throws for malformed digest", () => {
    expect(() => assertManagedCheckoutBinding("bad", {}, {})).toThrow(
      /exact user-confirmed checkout digest/,
    );
    expect(() => assertManagedCheckoutBinding(42 as unknown as string, {}, {})).toThrow();
  });
});
