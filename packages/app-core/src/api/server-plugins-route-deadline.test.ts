/**
 * resolveWithinDeadline (#13859): the /api/plugins cold-start guard. A pending
 * lazy-import resolves null at the deadline (route answers 503 + Retry-After)
 * instead of holding the socket open; a settled promise passes through
 * untouched, and a rejection propagates (never masked as a timeout).
 */

import { describe, expect, it } from "vitest";
import { resolveWithinDeadline } from "./server";

describe("resolveWithinDeadline", () => {
  it("returns the value when the promise settles inside the deadline", async () => {
    await expect(
      resolveWithinDeadline(Promise.resolve("warm"), 1_000),
    ).resolves.toBe("warm");
  });

  it("returns null when the promise is still pending at the deadline", async () => {
    const never = new Promise<string>(() => {});
    await expect(resolveWithinDeadline(never, 25)).resolves.toBeNull();
  });

  it("propagates rejection instead of converting it into a timeout null", async () => {
    const boom = Promise.reject(new Error("registry import failed"));
    await expect(resolveWithinDeadline(boom, 1_000)).rejects.toThrow(
      "registry import failed",
    );
  });
});
