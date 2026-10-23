/** Orphan-container listing must not report a failed `docker ps` as "no containers". */
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

const hostMocks = vi.hoisted(() => ({
  resolveHostExecutable: vi.fn((name: string) =>
    name === "docker" ? "/usr/bin/docker" : undefined,
  ),
}));

vi.mock("@elizaos/host", () => ({
  applyHostExecutionBaseline: (env: NodeJS.ProcessEnv) => env,
  resolveHostExecutable: hostMocks.resolveHostExecutable,
}));

const { DockerEngine } = await import("./sandbox-engine.ts");

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  hostMocks.resolveHostExecutable.mockImplementation((name: string) =>
    name === "docker" ? "/usr/bin/docker" : undefined,
  );
});

describe("DockerEngine.listContainers", () => {
  it("rejects when docker ps fails instead of reporting zero containers", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      const error = new Error(
        "permission denied while trying to connect to the Docker daemon socket",
      ) as NodeJS.ErrnoException & { status?: number };
      error.status = 1;
      throw error;
    });

    const engine = new DockerEngine();

    expect(() => engine.listContainers("eliza-sandbox")).toThrow(
      "Failed to list eliza-sandbox containers",
    );
  });

  it("keeps an empty successful listing as no containers", () => {
    vi.mocked(execFileSync).mockReturnValue("" as never);

    const engine = new DockerEngine();

    expect(engine.listContainers("eliza-sandbox")).toEqual([]);
  });

  it("keeps a missing docker binary as no engine to enumerate", () => {
    hostMocks.resolveHostExecutable.mockReturnValue(undefined);

    const engine = new DockerEngine();

    expect(engine.listContainers("eliza-sandbox")).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
