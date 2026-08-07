/** Verifies that the HTTP route kernel dispatches and translates failures once. */
import { describe, expect, it, vi } from "vitest";
import { createRouteKernel } from "./route-kernel.ts";

describe("route kernel", () => {
  it("dispatches requests without invoking failure translation", async () => {
    const dispatch = vi.fn(async () => undefined);
    const translateFailure = vi.fn();
    const kernel = createRouteKernel({ dispatch, translateFailure });
    const req = {} as Parameters<typeof kernel.handle>[0];
    const res = {} as Parameters<typeof kernel.handle>[1];
    await kernel.handle(req, res);
    expect(dispatch).toHaveBeenCalledWith(req, res);
    expect(translateFailure).not.toHaveBeenCalled();
  });

  it("translates a thrown route failure at the transport boundary", async () => {
    const failure = new Error("route failed");
    const translateFailure = vi.fn(async () => undefined);
    const kernel = createRouteKernel({
      dispatch: async () => {
        throw failure;
      },
      translateFailure,
    });
    const req = {} as Parameters<typeof kernel.handle>[0];
    const res = {} as Parameters<typeof kernel.handle>[1];
    await kernel.handle(req, res);
    expect(translateFailure).toHaveBeenCalledWith(failure, req, res);
  });
});
