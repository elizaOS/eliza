/**
 * Deterministic coverage for docker-node onboarding helpers. The tests exercise
 * argument parsing, container selection, and host-key pin preservation without
 * opening SSH connections or touching a real control-plane database.
 */
import { describe, expect, it } from "bun:test";
import {
  assertRobotOnboardAuthorityCompatible,
  buildOnboardSshConfig,
  capacityForOnboardUpsert,
  hostKeyFingerprintForOnboardUpsert,
  parseArgs,
  parseDockerPs,
  requireOnboardHostKeyFingerprint,
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

  it("never selects a stopped exact-restore candidate", () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const exactNames = Array.from({ length: 8 }, (_, index) => {
      const version = index + 1;
      const restoreAttemptId = `22222222-2222-${version}222-8222-222222222222`;
      return `agent-restore-${agentId}-${restoreAttemptId}`;
    });
    const states = ["created", "exited", "dead"];

    expect(
      selectZombieAgentContainers(
        exactNames.flatMap((name) => states.map((state) => ({ name, state }))),
      ),
    ).toEqual([]);
  });

  it("still selects true zombies whose names only resemble exact restore", () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const rows = [
      { name: `agent-restore-${agentId}-not-a-uuid`, state: "created" },
      {
        name: `agent-restored-${agentId}-22222222-2222-4222-8222-222222222222`,
        state: "dead",
      },
    ];

    expect(selectZombieAgentContainers(rows)).toEqual(
      rows.map((row) => row.name),
    );
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

  it("rejects parseInt-coercible --ssh-port tokens instead of selecting another port", () => {
    // Number.parseInt("1e4", 10) === 1, still inside 1..65535; dry-run then
    // printed `root@127.0.0.1:1`. Trailing junk and leading zeros are the
    // same class: the operator must get the port they typed, or an error.
    for (const value of [
      "1e4",
      "1E4",
      "8abc",
      "010",
      "22.0",
      "0x10",
      "65536",
    ]) {
      expect(() =>
        parseArgs(
          ["--host", "127.0.0.1", "--node-id", "n", "--ssh-port", value],
          emptyEnv,
        ),
      ).toThrow(/ssh-port/);
    }
    expect(
      parseArgs(
        ["--host", "127.0.0.1", "--node-id", "n", "--ssh-port", "2222"],
        emptyEnv,
      ).sshPort,
    ).toBe(2222);
    expect(
      parseArgs(
        ["--host", "127.0.0.1", "--node-id", "n", "--ssh-port", "1"],
        emptyEnv,
      ).sshPort,
    ).toBe(1);
    expect(
      parseArgs(
        ["--host", "127.0.0.1", "--node-id", "n", "--ssh-port", "65535"],
        emptyEnv,
      ).sshPort,
    ).toBe(65535);
  });

  it("rejects parseInt-coercible --capacity tokens instead of shrinking the slot count", () => {
    // Number.parseInt("1e2", 10) === 1, so `--capacity 1e2` used to print
    // `capacity=1` while `--capacity 100` correctly rejected as out of range.
    for (const value of [
      "1e2",
      "1E2",
      "8abc",
      "010",
      "4.5",
      "0x10",
      "0",
      "65",
    ]) {
      expect(() =>
        parseArgs(
          ["--host", "127.0.0.1", "--node-id", "n", "--capacity", value],
          emptyEnv,
        ),
      ).toThrow(/capacity/);
    }
    expect(
      parseArgs(
        ["--host", "127.0.0.1", "--node-id", "n", "--capacity", "1"],
        emptyEnv,
      ).capacity,
    ).toBe(1);
    expect(
      parseArgs(
        ["--host", "127.0.0.1", "--node-id", "n", "--capacity", "64"],
        emptyEnv,
      ).capacity,
    ).toBe(64);
  });

  it("applies the same canonical integer gate to the env fallbacks", () => {
    expect(() =>
      parseArgs(["--host", "h", "--node-id", "n"], {
        ONBOARD_NODE_SSH_PORT: "1e4",
      } as NodeJS.ProcessEnv),
    ).toThrow(/ssh-port/);
    expect(() =>
      parseArgs(["--host", "h", "--node-id", "n"], {
        ONBOARD_NODE_CAPACITY: "1e2",
      } as NodeJS.ProcessEnv),
    ).toThrow(/capacity/);
    expect(
      parseArgs(["--host", "h", "--node-id", "n"], {
        ONBOARD_NODE_SSH_PORT: "2200",
        ONBOARD_NODE_CAPACITY: "16",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ sshPort: 2200, capacity: 16 });
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
      { host_key_fingerprint: "pinned-fingerprint", capacity: 8 },
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
        { host_key_fingerprint: null, capacity: 8 },
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
        { host_key_fingerprint: "pinned-fingerprint", capacity: 8 },
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
        { host_key_fingerprint: null, capacity: 8 },
        "first-pin",
      ),
    ).toBe("first-pin");
    expect(hostKeyFingerprintForOnboardUpsert(null, undefined)).toBeNull();
  });

  it("requires a persisted or TOFU-captured fingerprint before source attestation", () => {
    expect(
      requireOnboardHostKeyFingerprint(
        { host_key_fingerprint: "pinned", capacity: 8 },
        undefined,
      ),
    ).toBe("pinned");
    expect(requireOnboardHostKeyFingerprint(null, "captured")).toBe("captured");
    expect(requireOnboardHostKeyFingerprint(null, "  captured  ")).toBe(
      "captured",
    );
    expect(() => requireOnboardHostKeyFingerprint(null, undefined)).toThrow(
      /host-key fingerprint/,
    );
  });
});

describe("Robot source authority", () => {
  it("accepts legacy/Robot targets but never reinterprets a typed Cloud row", () => {
    expect(() => assertRobotOnboardAuthorityCompatible(null)).not.toThrow();
    expect(() =>
      assertRobotOnboardAuthorityCompatible({
        fleet_kind: null,
        infrastructure_provider: null,
        provider_server_id: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertRobotOnboardAuthorityCompatible({
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        provider_server_id: null,
      }),
    ).not.toThrow();
    expect(() =>
      assertRobotOnboardAuthorityCompatible({
        fleet_kind: "cloud",
        infrastructure_provider: "hetzner",
        provider_server_id: "4242",
      }),
    ).toThrow(/Cloud node/);
    for (const ambiguous of [
      {
        fleet_kind: null,
        infrastructure_provider: "hetzner" as const,
        provider_server_id: null,
      },
      {
        fleet_kind: "robot" as const,
        infrastructure_provider: null,
        provider_server_id: null,
      },
    ]) {
      expect(() => assertRobotOnboardAuthorityCompatible(ambiguous)).toThrow(
        /Cloud node/,
      );
    }
  });
});

describe("capacityForOnboardUpsert", () => {
  it("preserves an existing node's operator-tuned capacity across re-onboard", () => {
    // Robot the operator bumped to 24 via a direct DB write; the --capacity
    // flag still carries the small-box default and must not win.
    expect(
      capacityForOnboardUpsert(
        { host_key_fingerprint: "pinned", capacity: 24 },
        8,
      ),
    ).toBe(24);
  });

  it("seeds a brand-new row from the --capacity flag", () => {
    expect(capacityForOnboardUpsert(null, 8)).toBe(8);
    expect(capacityForOnboardUpsert(null, 4)).toBe(4);
  });
});
