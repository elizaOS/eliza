import { describe, expect, it } from "vitest";
import {
  classifyTrajectoryLoadError,
  shouldRetryTrajectoryLoad,
} from "./TrajectoriesView";

describe("classifyTrajectoryLoadError", () => {
  it("treats missing routes as an unavailable capability", () => {
    expect(classifyTrajectoryLoadError({ status: 404 })).toBe("unavailable");
    expect(classifyTrajectoryLoadError({ status: 405 })).toBe("unavailable");
  });

  it("keeps access restrictions distinct from connectivity failures", () => {
    expect(classifyTrajectoryLoadError({ status: 403 })).toBe("restricted");
    expect(classifyTrajectoryLoadError({ kind: "network" })).toBe("offline");
    expect(classifyTrajectoryLoadError({ status: 503 })).toBe("offline");
  });

  it("classifies the Shared runtime boundary as Dedicated-required", () => {
    const error = {
      status: 503,
      code: "trajectories_runtime_unavailable",
      data: { retryable: false },
    };

    expect(classifyTrajectoryLoadError(error)).toBe("dedicated-required");
    expect(shouldRetryTrajectoryLoad(error)).toBe(false);
  });

  it("preserves bounded warm-up retries for an untyped 503", () => {
    expect(shouldRetryTrajectoryLoad({ status: 503 })).toBe(true);
  });

  it("uses a generic safe state for unknown failures", () => {
    expect(
      classifyTrajectoryLoadError(new Error("sensitive server text")),
    ).toBe("error");
  });
});
