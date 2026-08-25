/** Verifies the legacy import is the canonical Devices product, not a wrapper. */
import { describe, expect, it } from "vitest";
import { DevicesRuntimesContainer } from "../settings/DevicesRuntimesContainer";
import { MyRuntimesContainer } from "./MyRuntimesContainer";

describe("MyRuntimesContainer compatibility adapter", () => {
  it("aliases the one canonical Devices & Runtimes container", () => {
    expect(MyRuntimesContainer).toBe(DevicesRuntimesContainer);
  });
});
