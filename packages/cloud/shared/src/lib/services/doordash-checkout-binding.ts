/** Binds a confirmed DoorDash checkout to the exact canonical cart and preview. */

import { createHash } from "node:crypto";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

export function managedCheckoutBindingDigest(cart: unknown, preview: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue({ cart, checkout: preview })))
    .digest("hex");
}

export function assertManagedCheckoutBinding(
  expectedDigest: unknown,
  cart: unknown,
  preview: unknown,
): void {
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("DoorDash checkout requires the exact user-confirmed checkout digest");
  }
  if (managedCheckoutBindingDigest(cart, preview) !== expectedDigest) {
    throw new Error(
      "DoorDash cart or checkout changed after confirmation; review the new preview before ordering",
    );
  }
}
