import { describe, expect, it } from "vitest";
import { resolvePathWithinRoot } from "../safe-path.js";

describe("resolvePathWithinRoot", () => {
  const root = "/tmp/trajectories";

  it("allows files under the trajectory root", () => {
    expect(resolvePathWithinRoot(root, "run-1.traj")).toBe(
      "/tmp/trajectories/run-1.traj",
    );
  });

  it("rejects traversal outside the root (GHSA-jvqc-qp6c-g58f)", () => {
    expect(() => resolvePathWithinRoot(root, "../../../etc/passwd")).toThrow(
      "Invalid path",
    );
    // Express decodes %2F before :filename reaches the handler.
    expect(() =>
      resolvePathWithinRoot(root, "../../etc/passwd"),
    ).toThrow("Invalid path");
    expect(() => resolvePathWithinRoot(root, "/etc/passwd")).toThrow(
      "Invalid path",
    );
  });

  it("rejects null-byte path injection", () => {
    expect(() => resolvePathWithinRoot(root, "safe.traj\0../../etc/passwd")).toThrow(
      "Invalid path",
    );
  });
});
