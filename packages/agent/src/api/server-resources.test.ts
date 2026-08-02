/** Verifies awaited reverse teardown and failure isolation for API resources. */
import { describe, expect, it, vi } from "vitest";
import {
  closeServerResources,
  createServerResources,
} from "./server-resources.ts";

describe("closeServerResources", () => {
  it("awaits every disposer in reverse order and reports failures", async () => {
    const events: string[] = [];
    const reportError = vi.fn();
    await closeServerResources(
      [
        {
          name: "first",
          dispose: () => {
            events.push("first");
          },
        },
        {
          name: "broken",
          dispose: async () => {
            events.push("broken");
            throw new Error("failed");
          },
        },
        {
          name: "last",
          dispose: () => {
            events.push("last");
          },
        },
      ],
      reportError,
    );
    expect(events).toEqual(["last", "broken", "first"]);
    expect(reportError).toHaveBeenCalledWith("broken", expect.any(Error));
  });

  it("owns an idempotent resource registry", async () => {
    const events: string[] = [];
    const resources = createServerResources(() => undefined);
    resources.add({ name: "first", dispose: () => events.push("first") });
    resources.add({ name: "second", dispose: () => events.push("second") });
    await Promise.all([resources.close(), resources.close()]);
    expect(events).toEqual(["second", "first"]);
    expect(() =>
      resources.add({ name: "late", dispose: () => undefined }),
    ).toThrow("after server teardown");
  });
});
