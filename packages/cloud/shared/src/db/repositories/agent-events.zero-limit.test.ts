/**
 * An explicit agent-event limit of 0 is an empty page. `limit || 50` and
 * `limit || 100` asked the database for the default page instead.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const findMany = mock(async (_options: { limit?: number }) => []);

mock.module("../helpers", () => ({
  dbRead: {
    query: {
      agentEvents: {
        findMany,
        findFirst: mock(async () => undefined),
      },
    },
  },
  dbWrite: {},
}));

const { AgentEventsRepository } = await import("./agent-events");

beforeEach(() => {
  findMany.mockClear();
});

test("treats an explicit agent-event limit of 0 as an empty page", async () => {
  const repository = new AgentEventsRepository();

  await repository.listByAgent("agent-1", { limit: 0 });
  expect(findMany.mock.calls[0]?.[0]).toMatchObject({ limit: 0 });

  await repository.listByAgent("agent-1");
  expect(findMany.mock.calls[1]?.[0]).toMatchObject({ limit: 50 });

  await repository.listByOrganization("org-1", { limit: 0 });
  expect(findMany.mock.calls[2]?.[0]).toMatchObject({ limit: 0 });

  await repository.listByOrganization("org-1", { limit: 3 });
  expect(findMany.mock.calls[3]?.[0]).toMatchObject({ limit: 3 });

  await repository.listByOrganization("org-1");
  expect(findMany.mock.calls[4]?.[0]).toMatchObject({ limit: 100 });
});
