// Exercises cloud admin prune node disk.test automation behavior with deterministic script fixtures.
import { describe, expect, it } from "bun:test";
import { parsePruneArgs } from "./prune-node-disk";

const EMPTY: NodeJS.ProcessEnv = {};

describe("parsePruneArgs", () => {
  it("accepts --node-id alone and applies SSH defaults", () => {
    const args = parsePruneArgs(["--node-id", "eliza-core-95ea703e"], EMPTY);
    expect(args).toEqual({
      nodeId: "eliza-core-95ea703e",
      sshPort: 22,
      sshUser: "root",
      dryRun: false,
    });
  });

  it("accepts --host alone with custom ssh user/port", () => {
    const args = parsePruneArgs(
      ["--host", "10.0.0.7", "--ssh-user", "deploy", "--ssh-port", "2222"],
      EMPTY,
    );
    expect(args).toEqual({
      host: "10.0.0.7",
      sshPort: 2222,
      sshUser: "deploy",
      dryRun: false,
    });
  });

  it("requires exactly one of --node-id / --host", () => {
    expect(() => parsePruneArgs([], EMPTY)).toThrow("exactly one of --node-id");
    expect(() =>
      parsePruneArgs(["--node-id", "a", "--host", "b"], EMPTY),
    ).toThrow("only ONE of --node-id or --host");
  });

  it("reads --dry-run", () => {
    const args = parsePruneArgs(["--node-id", "a", "--dry-run"], EMPTY);
    expect(args.dryRun).toBe(true);
  });

  it("falls back to env vars", () => {
    const args = parsePruneArgs([], {
      PRUNE_NODE_HOST: "1.2.3.4",
      PRUNE_NODE_SSH_USER: "ops",
    } as NodeJS.ProcessEnv);
    expect(args.host).toBe("1.2.3.4");
    expect(args.sshUser).toBe("ops");
  });

  it("accepts canonical ssh-port boundaries", () => {
    expect(
      parsePruneArgs(["--host", "h", "--ssh-port", "1"], EMPTY).sshPort,
    ).toBe(1);
    expect(
      parsePruneArgs(["--host", "h", "--ssh-port", "65535"], EMPTY).sshPort,
    ).toBe(65535);
  });

  it("rejects non-canonical and out-of-range ssh-port flags", () => {
    for (const value of [
      "1e4",
      "1E4",
      "8abc",
      "022",
      "22.0",
      "0x10",
      "0",
      "65536",
    ]) {
      expect(() =>
        parsePruneArgs(["--host", "h", "--ssh-port", value], EMPTY),
      ).toThrow(/ssh-port/);
    }
  });

  it("applies the canonical ssh-port gate to env fallbacks", () => {
    expect(() =>
      parsePruneArgs([], {
        PRUNE_NODE_HOST: "h",
        PRUNE_NODE_SSH_PORT: "1e4",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ssh-port/);
    expect(
      parsePruneArgs([], {
        PRUNE_NODE_HOST: "h",
        PRUNE_NODE_SSH_PORT: "2200",
      } as NodeJS.ProcessEnv).sshPort,
    ).toBe(2200);
  });
});
