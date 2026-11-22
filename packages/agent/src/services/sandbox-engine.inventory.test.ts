/**
 * A container inventory that could not be taken is not an empty inventory.
 * `docker ps` failing used to return `[]`, so sandbox start/recover skipped
 * orphan cleanup (sandbox-manager.ts:356/:408) and then collided with the
 * leftover container's name instead of reporting the engine fault.
 */
import { describe, expect, it, vi } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock("@elizaos/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/host")>();
  return { ...actual, resolveHostExecutable: () => "/usr/bin/docker" };
});

const { DockerEngine } = await import("./sandbox-engine.ts");

function stubPs(handler: () => string): void {
  execFileSyncMock.mockImplementation(
    (_binary: string, args: readonly string[]) => {
      if (args[0] !== "ps") return "";
      return handler();
    },
  );
}

describe("container inventory", () => {
  it("propagates a failed engine listing instead of reporting no containers", () => {
    stubPs(() => {
      throw new Error(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      );
    });

    let outcome: unknown;
    try {
      outcome = new DockerEngine().listContainers("eliza-sandbox-");
    } catch (error) {
      outcome = error;
    }

    expect(outcome).toMatchObject({
      code: "SANDBOX_ENGINE_INVENTORY_FAILED",
    });
  });

  it("still reports an empty list when the engine has no matching container", () => {
    stubPs(() => "");

    expect(new DockerEngine().listContainers("eliza-sandbox-")).toEqual([]);
  });
});
