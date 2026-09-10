/** Real PGlite tests for destination review races, durable pause state and pending-event preservation. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { LinkedCalendarControlRepository } from "./linked-calendar-control.js";
import { LinkedCalendarRepository } from "./linked-calendar-sync.js";
import {
  ensureLinkedCalendarControlTable,
  ensureLinkedCalendarEventTable,
} from "./migration.js";

const databases: PGlite[] = [];
const directories: string[] = [];
const destination = {
  connectorAccountId: "test-account",
  providerCalendarId: "disposable-calendar",
};

async function harness(dataDir?: string) {
  const pg = new PGlite(dataDir);
  databases.push(pg);
  await pg.exec("CREATE SCHEMA IF NOT EXISTS app_calendar");
  const execute = async (statement: string) =>
    (await pg.query<Record<string, unknown>>(statement)).rows;
  await ensureLinkedCalendarControlTable(execute);
  await ensureLinkedCalendarEventTable(execute);
  const runtime = (agentId = "owner-a") =>
    ({ agentId, adapter: { db: drizzle(pg) } }) as unknown as IAgentRuntime;
  return {
    pg,
    runtime,
    controls: () => new LinkedCalendarControlRepository(runtime()),
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((pg) => pg.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("durable linked calendar review", { timeout: 30_000 }, () => {
  it("rejects resume until a destination is selected and rejects replacement while active", async () => {
    const h = await harness();
    const controls = h.controls();
    const initial = await controls.read();
    expect(initial.destination).toBeNull();
    expect(initial.paused).toBe(true);
    await expect(controls.resume(initial.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    const reviewed = await controls.selectDestination(
      initial.revision,
      destination,
    );
    expect(reviewed.paused).toBe(true);
    const active = await controls.resume(reviewed.revision);
    expect(active.paused).toBe(false);
    expect((await h.controls().read()).destination).toEqual(destination);
    await expect(
      controls.selectDestination(active.revision, {
        ...destination,
        connectorAccountId: "replacement",
      }),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
  });

  it("retains the paused destination and revision after closing and reopening the database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "calendar-control-"));
    directories.push(directory);
    const h = await harness(directory);
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const paused = await h.controls().pause(active.revision);
    await h.pg.close();
    databases.splice(databases.indexOf(h.pg), 1);
    const reopened = await harness(directory);
    expect(await reopened.controls().read()).toEqual(paused);
    await expect(
      reopened.controls().resume(selected.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
  });

  it("allows only one concurrent review and rejects a stale resume", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const results = await Promise.allSettled([
      h.controls().selectDestination(initial.revision, destination),
      h.controls().selectDestination(initial.revision, {
        ...destination,
        providerCalendarId: "another-calendar",
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await expect(h.controls().resume(initial.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    expect((await h.controls().read()).paused).toBe(true);
  });

  it("preserves pending create, update and delete records when pausing and reviewing a replacement", async () => {
    const h = await harness();
    const runtime = h.runtime();
    const links = new LinkedCalendarRepository(runtime);
    for (const operation of ["create", "update", "delete"] as const) {
      const link = await links.create({
        agentId: runtime.agentId,
        localEventId: operation,
        ...destination,
        localRevision: 1,
      });
      await links.save(link, { pendingOperation: operation });
    }
    const before = await links.listForAgent(runtime.agentId);
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const paused = await h.controls().pause(active.revision);
    await h.controls().selectDestination(paused.revision, {
      ...destination,
      connectorAccountId: "real-account",
    });
    expect(await links.listForAgent(runtime.agentId)).toEqual(before);
    expect((await h.controls().read()).paused).toBe(true);
    const anotherOwner = new LinkedCalendarControlRepository(
      h.runtime("owner-b"),
    );
    expect((await anotherOwner.read()).destination).toBeNull();
  });

  it("rejects an incomplete destination without changing the reviewed state", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    await expect(
      h.controls().selectDestination(initial.revision, {
        ...destination,
        providerCalendarId: " ",
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DESTINATION_REQUIRED" });
    expect(await h.controls().read()).toEqual(initial);
  });
});
