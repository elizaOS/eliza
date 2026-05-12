import { describe, expect, it } from "bun:test";
import {
  CarrotStoreError,
  loadCarrotStoreSnapshot,
  toInstalledCarrotSnapshot,
} from "./index.js";

describe("carrot package barrel", () => {
  it("exports public store snapshot helpers", () => {
    expect(typeof CarrotStoreError).toBe("function");
    expect(typeof loadCarrotStoreSnapshot).toBe("function");
    expect(typeof toInstalledCarrotSnapshot).toBe("function");
  });
});
