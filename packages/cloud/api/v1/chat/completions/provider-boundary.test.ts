/** Every refusal at the provider boundary precedes the provider call. */
import { describe, expect, test } from "bun:test";
import {
  ClientClosedBeforeDispatchError,
  joinProviderBoundary,
} from "./provider-boundary";

describe("provider boundary", () => {
  test("an admission without a commit step reaches the provider with nothing awaited", async () => {
    await expect(
      joinProviderBoundary({ signal: new AbortController().signal })(),
    ).resolves.toBeUndefined();
  });

  test("a commit refusal is preserved", async () => {
    const refusal = Error("insufficient credits");
    await expect(
      joinProviderBoundary({
        signal: new AbortController().signal,
        commit: async () => {
          throw refusal;
        },
      })(),
    ).rejects.toBe(refusal);
  });

  test("a caller that already left commits nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let commits = 0;
    await expect(
      joinProviderBoundary({
        signal: controller.signal,
        commit: async () => {
          commits++;
        },
      })(),
    ).rejects.toBeInstanceOf(ClientClosedBeforeDispatchError);
    expect(commits).toBe(0);
  });

  test("a caller that leaves during the commit never reaches the provider", async () => {
    const controller = new AbortController();
    await expect(
      joinProviderBoundary({
        signal: controller.signal,
        commit: async () => {
          controller.abort();
        },
      })(),
    ).rejects.toBeInstanceOf(ClientClosedBeforeDispatchError);
  });
});
