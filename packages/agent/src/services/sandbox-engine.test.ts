import { describe, expect, it, vi } from "vitest";

describe("sandbox engine policy capabilities", () => {
  it("declares Docker as policy-capable and Apple Container as unsupported for general sandbox constraints", async () => {
    const {
      AppleContainerEngine,
      DockerEngine,
      GENERAL_SANDBOX_CONSTRAINTS,
      getUnsupportedSandboxConstraints,
    } = await import("./sandbox-engine.ts");

    expect(
      getUnsupportedSandboxConstraints(
        new DockerEngine(),
        GENERAL_SANDBOX_CONSTRAINTS,
      ),
    ).toEqual([]);
    expect(
      getUnsupportedSandboxConstraints(
        new AppleContainerEngine(),
        GENERAL_SANDBOX_CONSTRAINTS,
      ),
    ).toEqual(GENERAL_SANDBOX_CONSTRAINTS);
  });

  it("rejects unsupported Apple Container run flags before spawning a process", async () => {
    const { AppleContainerEngine } = await import("./sandbox-engine.ts");

    await expect(
      new AppleContainerEngine().runContainer({
        image: "eliza-sandbox:bookworm-slim",
        name: "test",
        detach: true,
        mounts: [],
        env: {},
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        memory: "512m",
        cpus: 1,
        pidsLimit: 256,
        readOnlyRoot: true,
      }),
    ).rejects.toThrow(/cannot enforce requested sandbox constraints/i);
  });

  it("skips Apple Container auto-selection when policy constraints are required", async () => {
    vi.resetModules();
    vi.doMock("node:os", () => ({
      arch: () => "arm64",
      platform: () => "darwin",
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn((binary: string, args: readonly string[]) => {
        if (binary === "container" && args[0] === "--version") {
          return "container 1.0.0";
        }
        if (binary === "docker" && args[0] === "info") return "";
        if (binary === "docker" && args[0] === "--version") {
          return "Docker version 1.0.0";
        }
        return "";
      }),
      spawn: vi.fn(),
    }));

    try {
      const { detectBestEngine, GENERAL_SANDBOX_CONSTRAINTS } = await import(
        "./sandbox-engine.ts"
      );

      expect(detectBestEngine().engineType).toBe("apple-container");
      expect(detectBestEngine(GENERAL_SANDBOX_CONSTRAINTS).engineType).toBe(
        "docker",
      );
    } finally {
      vi.doUnmock("node:os");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });
});
