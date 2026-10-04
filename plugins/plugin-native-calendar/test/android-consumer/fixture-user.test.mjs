import { describe, expect, it } from "vitest";
import { removeFixtureUser, waitForUserUnlocked } from "./fixture-user.mjs";

const OWNER = "Users:\n\tUserInfo{0:Owner:4c13} running";
const WITH_FIXTURE = `${OWNER}\n\tUserInfo{10:calendar-harness:2500} running`;

function device({ removal, lists }) {
  const commands = [];
  const run = (...args) => {
    commands.push(args.join(" "));
    if (args.includes("remove-user")) return removal();
    return lists.shift() ?? OWNER;
  };
  return { run, commands };
}

const noWait = { timeoutMs: 60_000, sleep: async () => {} };

describe("removeFixtureUser", () => {
  it("accepts an explicit removal", async () => {
    const { run, commands } = device({
      removal: () => "Success: removed user",
      lists: [],
    });
    await expect(removeFixtureUser(run, 10, noWait)).resolves.toBe(
      "Success: removed user",
    );
    expect(commands).toEqual(["shell pm remove-user 10"]);
  });

  it("treats the system's own ephemeral removal as complete", async () => {
    const { run, commands } = device({
      removal: () => {
        throw Object.assign(new Error("Command failed"), {
          stdout: "Error: couldn't remove user id 10\n",
        });
      },
      lists: [WITH_FIXTURE, WITH_FIXTURE, OWNER],
    });
    await expect(removeFixtureUser(run, 10, noWait)).resolves.toMatch(
      /removed by the system/,
    );
    expect(commands.filter((command) => command.includes("list"))).toHaveLength(
      3,
    );
  });

  it("fails when the user is still present at the deadline", async () => {
    const { run } = device({
      removal: () => "Error: couldn't remove user id 10",
      lists: new Array(10).fill(WITH_FIXTURE),
    });
    await expect(
      removeFixtureUser(run, 10, { timeoutMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/still present/);
  });

  it("does not mistake another user id for the fixture user", async () => {
    const { run } = device({
      removal: () => "Error: couldn't remove user id 1",
      lists: [WITH_FIXTURE],
    });
    await expect(removeFixtureUser(run, 1, noWait)).resolves.toMatch(
      /removed by the system/,
    );
  });
});

describe("waitForUserUnlocked", () => {
  const states = (values) => {
    const polled = [];
    const run = (...args) => {
      polled.push(args.join(" "));
      return values.length > 1 ? values.shift() : values[0];
    };
    return { run, polled };
  };

  it("returns once the user unlocks", async () => {
    const { run, polled } = states(["RUNNING_LOCKED", "RUNNING_UNLOCKED"]);
    await waitForUserUnlocked(run, 10, noWait);
    expect(polled).toEqual([
      "shell am get-started-user-state 10",
      "shell am get-started-user-state 10",
    ]);
  });

  it("fails at the deadline instead of waiting forever", async () => {
    const { run } = states(["RUNNING_LOCKED"]);
    await expect(
      waitForUserUnlocked(run, 10, { timeoutMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/did not unlock: RUNNING_LOCKED/);
  });

  it("stops at once when the host cancels", async () => {
    const { run, polled } = states(["RUNNING_LOCKED"]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForUserUnlocked(run, 10, { ...noWait, signal: controller.signal }),
    ).rejects.toThrow();
    expect(polled).toEqual([]);
  });
});
