/**
 * Verifies the real Docker/Apple Container argv contract without invoking a
 * container daemon. Both engines share this builder, so environment parity is
 * tested at the process boundary rather than through an engine mock.
 */

import { describe, expect, it } from "vitest";
import { buildContainerExecArgs } from "./sandbox-engine.ts";

describe("container exec environment forwarding", () => {
  it("forwards explicit environment values for Docker and Apple Container", () => {
    expect(
      buildContainerExecArgs({
        containerId: "sandbox-1",
        command: "git status",
        workdir: "/workspace",
        env: { SAFE: "yes", EMPTY: "" },
      }),
    ).toEqual([
      "exec",
      "-w",
      "/workspace",
      "-e",
      "SAFE=yes",
      "-e",
      "EMPTY=",
      "sandbox-1",
      "git",
      "status",
    ]);
  });

  it("does not add host environment flags when no overlay is supplied", () => {
    expect(
      buildContainerExecArgs({
        containerId: "sandbox-1",
        command: "env",
      }),
    ).toEqual(["exec", "sandbox-1", "env"]);
  });
});
