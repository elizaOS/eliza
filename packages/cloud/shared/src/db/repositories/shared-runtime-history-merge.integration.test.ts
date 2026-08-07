/**
 * Drives concurrent shared-runtime history merges against real in-process
 * PGlite so the row lock and JSONB update are exercised without mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { sharedRuntimeHistory } from "../schemas/shared-runtime-history";
import { sharedRuntimeHistoryRepository } from "./shared-runtime-history";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[shared-runtime-history-merge.integration.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
    );
    return;
  }
  try {
    const { apply } = await pushSchema({ sharedRuntimeHistory } as never, dbWrite as never);
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[shared-runtime-history-merge.integration.test] PGlite schema setup failed.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(sharedRuntimeHistory);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("SharedRuntimeHistoryRepository.merge", () => {
  test("concurrent first writes preserve both turns", async () => {
    await Promise.all([
      sharedRuntimeHistoryRepository.merge(
        "agent-1",
        "channel-1",
        [
          { id: "user-1", role: "user", content: "first", createdAt: 1 },
          {
            id: "assistant-1",
            role: "assistant",
            content: "first reply",
            createdAt: 2,
          },
        ],
        40,
      ),
      sharedRuntimeHistoryRepository.merge(
        "agent-1",
        "channel-1",
        [
          { id: "user-2", role: "user", content: "second", createdAt: 3 },
          {
            id: "assistant-2",
            role: "assistant",
            content: "second reply",
            createdAt: 4,
          },
        ],
        40,
      ),
    ]);

    const stored = await sharedRuntimeHistoryRepository.get("agent-1", "channel-1");
    expect(stored.map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
  });

  test("a stale direct-writer snapshot cannot erase a mirrored turn", async () => {
    await sharedRuntimeHistoryRepository.merge(
      "agent-1",
      "channel-1",
      [
        { id: "do-user", role: "user", content: "voice", createdAt: 1 },
        {
          id: "do-assistant",
          role: "assistant",
          content: "partial",
          createdAt: 2,
          interrupted: true,
        },
      ],
      40,
    );

    await sharedRuntimeHistoryRepository.merge(
      "agent-1",
      "channel-1",
      [
        { id: "external-user", role: "user", content: "gateway", createdAt: 3 },
        {
          id: "external-assistant",
          role: "assistant",
          content: "gateway reply",
          createdAt: 4,
        },
      ],
      40,
    );

    const stored = await sharedRuntimeHistoryRepository.get("agent-1", "channel-1");
    expect(stored.map((message) => message.id)).toEqual([
      "do-user",
      "do-assistant",
      "external-user",
      "external-assistant",
    ]);
  });
});
