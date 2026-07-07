/**
 * Unit coverage for classifyDockerSshProbeError: the pure classification that a
 * readiness probe uses to tell a TRANSPORT failure (SSH channel never reached
 * the container — retry, never condemn) apart from a REMOTE non-zero exit (the
 * container was reached and the probe command said not-ready). This is the
 * fulcrum of the #15310 failure-mode-#6 fix, so it is pinned in isolation so it
 * can't silently drift from the exact error strings DockerSSHClient.exec throws.
 */
import { describe, expect, test } from "bun:test";
import { classifyDockerSshProbeError } from "../docker-ssh";

describe("classifyDockerSshProbeError", () => {
  test("non-zero exit code (remote shell RAN) → 'remote' (container reached, said not-ready)", () => {
    // The exact shape DockerSSHClient.exec rejects with on a non-zero exit.
    const err = new Error(
      "[docker-ssh] Command exited with code 1 on 10.0.0.5: [stderr] curl: (7) connection refused",
    );
    expect(classifyDockerSshProbeError(err)).toBe("remote");
  });

  test("any non-zero exit code, not just 1 → 'remote'", () => {
    const err = new Error("[docker-ssh] Command exited with code 137 on host-a: ");
    expect(classifyDockerSshProbeError(err)).toBe("remote");
  });

  test("connection error → 'transport' (never reached the container)", () => {
    const err = new Error("[docker-ssh] Connection error for 10.0.0.5: ETIMEDOUT");
    expect(classifyDockerSshProbeError(err)).toBe("transport");
  });

  test("exec error → 'transport'", () => {
    const err = new Error("[docker-ssh] exec error on 10.0.0.5: channel open failure");
    expect(classifyDockerSshProbeError(err)).toBe("transport");
  });

  test("stream error → 'transport'", () => {
    const err = new Error("[docker-ssh] stream error on 10.0.0.5: read ECONNRESET");
    expect(classifyDockerSshProbeError(err)).toBe("transport");
  });

  test("command timeout (fired before any exit code) → 'transport'", () => {
    const err = new Error(
      "[docker-ssh] Command timed out after 10000ms on 10.0.0.5: docker [redacted]",
    );
    expect(classifyDockerSshProbeError(err)).toBe("transport");
  });

  test("non-Error input is coerced and defaults to 'transport'", () => {
    expect(classifyDockerSshProbeError("ETIMEDOUT")).toBe("transport");
    expect(classifyDockerSshProbeError(null)).toBe("transport");
    expect(classifyDockerSshProbeError(undefined)).toBe("transport");
  });

  test("a stringified remote-exit still classifies as 'remote'", () => {
    expect(classifyDockerSshProbeError("Command exited with code 2")).toBe("remote");
  });
});
