import { describe, expect, it, vi } from "vitest";
import { cachedDynamicImport } from "./app-module-cache";

describe("deferred module loading", () => {
  it("shares in-flight and successful imports", async () => {
    const module = { ready: true };
    const loader = vi.fn(async () => module);
    const first = cachedDynamicImport("shared-test", loader);
    expect(cachedDynamicImport("shared-test", loader)).toBe(first);
    await expect(first).resolves.toBe(module);
    await expect(cachedDynamicImport("shared-test", loader)).resolves.toBe(
      module,
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("allows retry after a rejected import", async () => {
    const failure = new Error("temporary chunk fetch failure");
    const loader = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ ready: true });
    await expect(cachedDynamicImport("retry-test", loader)).rejects.toBe(
      failure,
    );
    await expect(cachedDynamicImport("retry-test", loader)).resolves.toEqual({
      ready: true,
    });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("turns synchronous loader failures into retryable rejections", async () => {
    await expect(
      cachedDynamicImport("sync-test", () => {
        throw new Error("load failed");
      }),
    ).rejects.toThrow("load failed");
    await expect(
      cachedDynamicImport("sync-test", async () => 42),
    ).resolves.toBe(42);
  });
});
