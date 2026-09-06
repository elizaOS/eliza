/**
 * Exercises the retained-stop protocol against a stateful Docker transport
 * fixture, including uncertain responses and stale ownership. No live host is used.
 */
import { describe, expect, test } from "bun:test";
import {
  captureDockerRetainedContainer,
  checkDockerRetainedContainerHealth,
  deleteDockerRetainedContainer,
  resumeDockerRetainedContainer,
  stopDockerRetainingState,
} from "./docker-retained-stop";

const ID = "a".repeat(64);
const AGENT = "11111111-1111-4111-8111-111111111111";

function dockerFixture(
  options: {
    lostStopResponse?: boolean;
    lostStartResponse?: boolean;
    stopFailed?: boolean;
    wrongOwner?: boolean;
    updateFailed?: boolean;
    disappear?: boolean;
    lostRemoveResponse?: boolean;
    removeFailed?: boolean;
    absenceUnknown?: boolean;
  } = {},
) {
  let running = true;
  let restart = "always";
  let removed = false;
  let mutations = 0;
  const state = {
    contents: "retained conversation and local database",
    mounts: ["/data/agents/state"],
  };
  return {
    state,
    read: () => ({ running, restart, removed, mutations }),
    execute: async (command: string) => {
      if (command.startsWith("sh -c ")) {
        if (options.absenceUnknown) return "unknown";
        if (removed) return "absent";
        return `present|${ID}|${options.wrongOwner ? "22222222-2222-4222-8222-222222222222" : AGENT}`;
      }
      if (command.startsWith("docker container inspect")) {
        const owner = options.wrongOwner ? "22222222-2222-4222-8222-222222222222" : AGENT;
        if (command.includes(".State.Status")) {
          if (options.disappear) throw new Error("No such object");
          return `${ID}|${owner}|${running ? "running" : "exited"}|${running}|false|false|false|${restart}`;
        }
        return `${ID}|${owner}`;
      }
      mutations++;
      if (command.startsWith("docker update")) {
        if (options.updateFailed) throw new Error("update rejected");
        restart = "no";
        return ID;
      }
      if (command.startsWith("docker start")) {
        running = true;
        if (options.lostStartResponse) throw new Error("start response lost");
        return ID;
      }
      if (command.startsWith("docker stop")) {
        if (options.stopFailed) throw new Error("stop rejected");
        running = false;
        if (options.lostStopResponse) throw new Error("transport response lost");
        return ID;
      }
      if (command.includes("rm")) {
        if (options.removeFailed) throw new Error("remove rejected");
        removed = true;
        state.contents = "";
        if (options.lostRemoveResponse) throw new Error("remove response lost");
        return ID;
      }
      throw new Error(`Unexpected provider mutation: ${command}`);
    },
  };
}

describe("retained Docker stop", () => {
  test("deletion resolves lost removal acknowledgement and replays without another mutation", async () => {
    const docker = dockerFixture({ lostRemoveResponse: true });
    await deleteDockerRetainedContainer(docker.execute, ID, AGENT);
    expect(docker.read().removed).toBe(true);
    const mutations = docker.read().mutations;
    await deleteDockerRetainedContainer(docker.execute, ID, AGENT);
    expect(docker.read().mutations).toBe(mutations);
  });

  test("deletion refuses unknown absence or a different owner before mutating", async () => {
    for (const options of [{ absenceUnknown: true }, { wrongOwner: true }]) {
      const docker = dockerFixture(options);
      await expect(deleteDockerRetainedContainer(docker.execute, ID, AGENT)).rejects.toThrow(
        "cannot prove exact ownership or absence",
      );
      expect(docker.read().mutations).toBe(0);
    }
  });

  test("deletion failure keeps the stopped container and refuses a success receipt", async () => {
    const docker = dockerFixture({ removeFailed: true });
    await expect(deleteDockerRetainedContainer(docker.execute, ID, AGENT)).rejects.toThrow(
      "did not prove exact container absence",
    );
    expect(docker.read().removed).toBe(false);
    expect(docker.read().running).toBe(false);
    expect(docker.state.contents).toContain("retained conversation");
  });

  test("stops compute and restart while retaining state and container", async () => {
    const docker = dockerFixture();
    const receipt = await stopDockerRetainingState(docker.execute, ID, AGENT);
    expect(receipt.state).toBe("exited");
    expect(docker.read()).toEqual({ running: false, restart: "no", removed: false, mutations: 2 });
    expect(docker.state.contents).toBe("retained conversation and local database");
    await stopDockerRetainingState(docker.execute, ID, AGENT);
    expect(docker.read().removed).toBe(false);
  });
  test("settles a lost stop response using exact final readback", async () => {
    const docker = dockerFixture({ lostStopResponse: true });
    expect((await stopDockerRetainingState(docker.execute, ID, AGENT)).state).toBe("exited");
    expect(docker.read().running).toBe(false);
  });
  test("does not report stopped when stop failed and runtime remains running", async () => {
    const docker = dockerFixture({ stopFailed: true });
    await expect(stopDockerRetainingState(docker.execute, ID, AGENT)).rejects.toThrow(
      "not proven stopped",
    );
    expect(docker.read().running).toBe(true);
    expect(docker.read().removed).toBe(false);
  });
  test("refuses owner mismatch before mutation", async () => {
    const docker = dockerFixture({ wrongOwner: true });
    await expect(stopDockerRetainingState(docker.execute, ID, AGENT)).rejects.toThrow("ownership");
    expect(docker.read().mutations).toBe(0);
  });
  test("requires restart policy update before stopping", async () => {
    const docker = dockerFixture({ updateFailed: true });
    await expect(stopDockerRetainingState(docker.execute, ID, AGENT)).rejects.toThrow(
      "update rejected",
    );
    expect(docker.read().running).toBe(true);
  });
  test("absence cannot stand in for retained state proof", async () => {
    const docker = dockerFixture({ disappear: true });
    await expect(stopDockerRetainingState(docker.execute, ID, AGENT)).rejects.toThrow(
      "No such object",
    );
  });
  test("rejects reusable names and malformed IDs before transport", async () => {
    const docker = dockerFixture();
    await expect(stopDockerRetainingState(docker.execute, "agent-name", AGENT)).rejects.toThrow(
      "immutable",
    );
    expect(docker.read().mutations).toBe(0);
  });
});

test("retained resume preserves state and is idempotent after a lost start response", async () => {
  const docker = dockerFixture({ lostStartResponse: true });
  await stopDockerRetainingState(docker.execute, ID, AGENT);
  await resumeDockerRetainedContainer(docker.execute, ID, AGENT);
  const mutations = docker.read().mutations;
  await resumeDockerRetainedContainer(docker.execute, ID, AGENT);
  expect(docker.read().mutations).toBe(mutations);
  expect(docker.read().running).toBe(true);
  expect(docker.read().restart).toBe("no");
  expect(docker.state.contents).toBe("retained conversation and local database");
});
test("capture refuses an agent label mismatch before deriving stop authority", async () => {
  await expect(
    captureDockerRetainedContainer(
      async () => `${ID}|wrong-agent|/agent-${AGENT}`,
      `agent-${AGENT}`,
      AGENT,
    ),
  ).rejects.toThrow("does not match");
  expect(
    await captureDockerRetainedContainer(
      async () => `${ID}|${AGENT}|/agent-${AGENT}`,
      `agent-${AGENT}`,
      AGENT,
    ),
  ).toBe(ID);
});

describe("exact retained-container health", () => {
  const healthy = `${ID}|${AGENT}|running|true|false|false|false|no|healthy`;
  test("reads the immutable ID and accepts healthy owned compute", async () => {
    const commands: string[] = [];
    expect(
      await checkDockerRetainedContainerHealth(
        async (command) => {
          commands.push(command);
          return healthy;
        },
        ID,
        AGENT,
      ),
    ).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`'${ID}'`);
    expect(commands[0]).not.toContain("curl");
  });
  for (const [name, response] of [
    ["unhealthy", healthy.replace(/healthy$/, "unhealthy")],
    ["starting", healthy.replace(/healthy$/, "starting")],
    ["missing health", healthy.replace(/healthy$/, "none")],
    ["stopped", healthy.replace("running|true", "exited|false")],
    ["restart enabled", healthy.replace("|no|", "|always|")],
    ["paused", healthy.replace("running|true|false|false", "paused|true|false|true")],
  ])
    test(`does not admit ${name}`, async () => {
      expect(await checkDockerRetainedContainerHealth(async () => response, ID, AGENT)).toBe(false);
    });
  for (const response of [
    healthy.replace(ID, "b".repeat(64)),
    healthy.replace(AGENT, crypto.randomUUID()),
    "healthy",
  ]) {
    test("rejects mismatched or malformed authority", async () => {
      await expect(
        checkDockerRetainedContainerHealth(async () => response, ID, AGENT),
      ).rejects.toThrow();
    });
  }
  test("does not dispatch an unvalidated identity", async () => {
    let calls = 0;
    await expect(
      checkDockerRetainedContainerHealth(
        async () => {
          calls++;
          return healthy;
        },
        "name",
        AGENT,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
