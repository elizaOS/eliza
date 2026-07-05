/**
 * Deterministic coverage for docker-node onboarding helpers. The tests exercise
 * argument parsing, container selection, and host-key pin preservation without
 * opening SSH connections or touching a real control-plane database.
 */
import { describe, expect, it } from "bun:test";
import {
  buildOnboardSshConfig,
  hostKeyFingerprintForOnboardUpsert,
  parseArgs,
  parseDockerPs,
  selectZombieAgentContainers,
} from "./onboard-docker-node";

describe("parseDockerPs", () => {
  it("parses name/state pairs and drops blank + stderr lines", () => {
    const out = [
      "agent-abc\texited",
      "",
      "cloud-container-xyz\trunning",
      "[stderr] some warning",
      "  unrelated-svc\tcreated  ",
    ].join("\n");
    expect(parseDockerPs(out)).toEqual([
      { name: "agent-abc", state: "exited" },
      { name: "cloud-container-xyz", state: "running" },
      { name: "unrelated-svc", state: "created" },
    ]);
  });

  it("returns empty for empty output", () => {
    expect(parseDockerPs("")).toEqual([]);
  });
});

describe("selectZombieAgentContainers", () => {
  it("selects exited/created/dead agent containers (both naming schemes)", () => {
    const rows = [
      { name: "agent-1", state: "exited" },
      { name: "cloud-container-2", state: "created" },
      { name: "agent-3", state: "dead" },
    ];
    expect(selectZombieAgentContainers(rows)).toEqual([
      "agent-1",
      "cloud-container-2",
      "agent-3",
    ]);
  });

  it("never selects a running/restarting/paused agent container (active sandbox safe)", () => {
    const rows = [
      { name: "agent-live", state: "running" },
      { name: "cloud-container-live", state: "restarting" },
      { name: "agent-paused", state: "paused" },
    ];
    expect(selectZombieAgentContainers(rows)).toEqual([]);
  });

  it("ignores non-agent containers even when exited", () => {
    const rows = [
      { name: "caddy", state: "exited" },
      { name: "postgres", state: "dead" },
      { name: "my-agent-helper", state: "exited" }, // does not START with a prefix
    ];
    expect(selectZombieAgentContainers(rows)).toEqual([]);
  });
});

describe("parseArgs", () => {
  const emptyEnv = {} as NodeJS.ProcessEnv;

  it("parses flags with defaults", () => {
    const args = parseArgs(
      ["--host", "1.2.3.4", "--node-id", "robot-1", "--key", "/k/id"],
      emptyEnv,
    );
    expect(args).toMatchObject({
      host: "1.2.3.4",
      nodeId: "robot-1",
      keyPath: "/k/id",
      sshPort: 22,
      sshUser: "root",
      capacity: 8,
      dryRun: false,
    });
  });

  it("honors --dry-run and explicit overrides", () => {
    const args = parseArgs(
      [
        "--host",
        "h",
        "--node-id",
        "n",
        "--ssh-port",
        "2222",
        "--ssh-user",
        "ops",
        "--capacity",
        "4",
        "--dry-run",
      ],
      emptyEnv,
    );
    expect(args).toMatchObject({
      sshPort: 2222,
      sshUser: "ops",
      capacity: 4,
      dryRun: true,
    });
  });

  it("falls back to env vars when flags are absent", () => {
    const env = {
      ONBOARD_NODE_HOST: "5.6.7.8",
      ONBOARD_NODE_ID: "env-node",
      ONBOARD_NODE_CAPACITY: "16",
    } as NodeJS.ProcessEnv;
    const args = parseArgs([], env);
    expect(args).toMatchObject({
      host: "5.6.7.8",
      nodeId: "env-node",
      capacity: 16,
    });
  });

  it("throws when host or node-id is missing", () => {
    expect(() => parseArgs(["--host", "h"], emptyEnv)).toThrow("node-id");
    expect(() => parseArgs(["--node-id", "n"], emptyEnv)).toThrow("host");
  });

  it("rejects an out-of-range capacity and ssh-port", () => {
    expect(() =>
      parseArgs(
        ["--host", "h", "--node-id", "n", "--capacity", "99"],
        emptyEnv,
      ),
    ).toThrow("capacity");
    expect(() =>
      parseArgs(["--host", "h", "--node-id", "n", "--ssh-port", "0"], emptyEnv),
    ).toThrow("ssh-port");
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseArgs(["--host", "--node-id", "n"], emptyEnv)).toThrow(
      "requires a value",
    );
  });
});

describe("host-key pinning helpers", () => {
  const args = {
    host: "203.0.113.10",
    nodeId: "robot-1",
    keyPath: "/ssh/key",
    sshPort: 2222,
    sshUser: "root",
    capacity: 8,
    dryRun: false,
  };

  it("passes an existing docker node pin into the SSH verifier before re-onboard", () => {
    const onHostKeyDiscovered = async () => {};
    const config = buildOnboardSshConfig(
      args,
      { host_key_fingerprint: "pinned-fingerprint" },
      onHostKeyDiscovered,
    );

    expect(config).toEqual({
      hostname: "203.0.113.10",
      port: 2222,
      username: "root",
      privateKeyPath: "/ssh/key",
      hostKeyFingerprint: "pinned-fingerprint",
      onHostKeyDiscovered,
    });
  });

  it("uses TOFU only when the existing docker node is unpinned or absent", () => {
    const onHostKeyDiscovered = async () => {};

    expect(
      buildOnboardSshConfig(
        args,
        { host_key_fingerprint: null },
        onHostKeyDiscovered,
      ).hostKeyFingerprint,
    ).toBeUndefined();
    expect(
      buildOnboardSshConfig(args, null, onHostKeyDiscovered).hostKeyFingerprint,
    ).toBeUndefined();
  });

  it("never overwrites an established pin with a re-onboard capture", () => {
    expect(
      hostKeyFingerprintForOnboardUpsert(
        { host_key_fingerprint: "pinned-fingerprint" },
        "attacker-fingerprint",
      ),
    ).toBe("pinned-fingerprint");
  });

  it("persists the captured fingerprint for first onboard or still-unpinned nodes", () => {
    expect(hostKeyFingerprintForOnboardUpsert(null, "first-pin")).toBe(
      "first-pin",
    );
    expect(
      hostKeyFingerprintForOnboardUpsert(
        { host_key_fingerprint: null },
        "first-pin",
      ),
    ).toBe("first-pin");
    expect(hostKeyFingerprintForOnboardUpsert(null, undefined)).toBeNull();
  });
});
