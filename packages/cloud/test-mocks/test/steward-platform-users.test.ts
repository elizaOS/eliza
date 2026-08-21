/** Verifies the loopback Steward platform-user mock through its real HTTP boundary. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type RunningStewardMock, startStewardMock } from "../src/steward";

let mock: RunningStewardMock;

beforeAll(async () => {
  mock = await startStewardMock();
});

afterAll(async () => {
  await mock.stop();
});

describe("Steward platform user lifecycle mock", () => {
  test("requires the platform key and records deactivate/delete transitions", async () => {
    const userId = "steward-fixture-user";
    const unauthorized = await fetch(
      `${mock.url}/platform/users/${userId}/deactivate`,
      {
        method: "PATCH",
      },
    );
    expect(unauthorized.status).toBe(401);

    const headers = { "x-steward-platform-key": "steward-e2e-platform-key" };
    const deactivated = await fetch(
      `${mock.url}/platform/users/${userId}/deactivate`,
      {
        method: "PATCH",
        headers,
      },
    );
    expect(deactivated.status).toBe(200);
    expect(mock.users.get(userId)).toBe("deactivated");

    const deleted = await fetch(`${mock.url}/platform/users/${userId}`, {
      method: "DELETE",
      headers,
    });
    expect(deleted.status).toBe(200);
    expect(mock.users.get(userId)).toBe("deleted");
  });
});
