import { afterAll, beforeAll, describe, test } from "bun:test";

const PREV_MOCK = process.env.MOCK_REDIS;

beforeAll(() => {
  process.env.MOCK_REDIS = "1";
});

afterAll(() => {
  if (PREV_MOCK === undefined) {
    delete process.env.MOCK_REDIS;
  } else {
    process.env.MOCK_REDIS = PREV_MOCK;
  }
});

describe("operator capabilities/redis (MOCK_REDIS=1)", () => {
  test("setServerState + setAgentServer + cleanupServer round-trip", async () => {
    const { setServerState, setAgentServer, cleanupServer } = await import(
      "../redis"
    );

    await setServerState("server-a", "ready", "http://server-a.local");
    await setAgentServer("agent-1", "server-a");
    await setAgentServer("agent-2", "server-a");

    // cleanupServer should succeed and remove tracked keys without throwing
    await cleanupServer("server-a", ["agent-1", "agent-2"]);
  });
});
