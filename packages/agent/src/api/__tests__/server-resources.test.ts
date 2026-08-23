import { describe, expect, it, vi } from "vitest";
import {
  closeServerResources,
  createServerResources,
} from "./server-resources.ts";

describe("createServerResources", () => {
  it("closes resources in reverse registration order", async () => {
    const order: string[] = [];
    const resources = createServerResources(() => undefined);
    resources.add({
      name: "a",
      dispose: () => {
        order.push("a");
      },
    });
    resources.add({
      name: "b",
      dispose: () => {
        order.push("b");
      },
    });
    await resources.close();
    expect(order).toEqual(["b", "a"]);
  });

  it("reports failures and continues teardown", async () => {
    const report = vi.fn();
    const resources = createServerResources(report);
    resources.add({
      name: "a",
      dispose: () => {
        throw new Error("boom");
      },
    });
    resources.add({ name: "b", dispose: () => undefined });
    await resources.close();
    expect(report).toHaveBeenCalledWith("a", expect.any(Error));
  });

  it("close is idempotent", async () => {
    const dispose = vi.fn();
    const resources = createServerResources(() => undefined);
    resources.add({ name: "a", dispose });
    await resources.close();
    await resources.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects registration after teardown", async () => {
    const resources = createServerResources(() => undefined);
    await resources.close();
    expect(() =>
      resources.add({ name: "late", dispose: () => undefined }),
    ).toThrow("after server teardown");
  });
});

describe("closeServerResources", () => {
  it("handles empty lists", async () => {
    await expect(
      closeServerResources([], () => undefined),
    ).resolves.toBeUndefined();
  });
});
