/** A failing engine listing must not be read as "there are no sandbox containers". */
import { describe, expect, it, vi } from "vitest";

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock("node:child_process", () => ({ execFileSync, spawn: vi.fn() }));
vi.mock("@elizaos/host", () => ({
  applyHostExecutionBaseline: (env: NodeJS.ProcessEnv) => env,
  resolveHostExecutable: (name: string) => `/usr/bin/${name}`,
}));

const { DockerEngine } = await import("./sandbox-engine.ts");

describe("DockerEngine.listContainers", () => {
  it("surfaces a failed listing instead of an empty orphan list", () => {
    execFileSync.mockReset();
    execFileSync.mockImplementation(() => {
      throw new Error(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      );
    });

    expect(() => new DockerEngine().listContainers("eliza-sandbox-")).toThrow(
      /cannot list containers/i,
    );
  });

  it("still returns [] when the engine answers with no matching containers", () => {
    execFileSync.mockReset();
    execFileSync.mockImplementation(() => "\n");

    expect(new DockerEngine().listContainers("eliza-sandbox-")).toEqual([]);
  });
});
