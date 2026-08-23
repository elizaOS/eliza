// @vitest-environment jsdom

/** Verifies production LifeOps review links use the remount-safe navigation bus. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchNavigateViewEvent } = vi.hoisted(() => ({
  dispatchNavigateViewEvent: vi.fn(),
}));

// The package test config aliases UI subpaths to one lightweight module, so
// expose both imports that the production adapter consumes from that module.
vi.mock("@elizaos/ui/api", () => ({
  client: {},
  dispatchNavigateViewEvent,
}));

import { defaultLifeOpsConnectionsAdapter } from "./adapter.js";

describe("LifeOps connection navigation", () => {
  beforeEach(() => {
    dispatchNavigateViewEvent.mockClear();
  });

  it.each([
    ["/inbox", "inbox"],
    ["/calendar", "calendar"],
  ] as const)("hands %s to the registered %s view", (path, viewId) => {
    defaultLifeOpsConnectionsAdapter.navigate(path);

    expect(dispatchNavigateViewEvent).toHaveBeenCalledOnce();
    expect(dispatchNavigateViewEvent).toHaveBeenCalledWith({
      viewId,
      viewPath: path,
      source: "user",
    });
  });
});
