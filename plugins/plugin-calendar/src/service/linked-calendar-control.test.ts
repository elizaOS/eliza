/** Real PGlite tests for destination review races, durable pause state and pending-event preservation. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { CalendarService } from "./CalendarService.js";
import type { CalendarHostGate } from "./gate.js";
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
  it("exposes pending work without its receipt and returns a conflict for a blocked owner change", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "owner-review-event", destination);
    const service = new CalendarService(h.runtime());
    const paused = await service.executeLinkedCalendarControl(
      new URL("http://localhost"),
      {
        operation: "pause",
        expectedRevision: active.revision,
        idempotencyKey: "pause-owner-review",
      },
    );
    expect(paused.paused).toBe(true);
    expect(paused.pendingDispatch?.linkId).toBe("owner-review-event");
    expect(JSON.stringify(paused)).not.toContain(token);
    await expect(
      service.executeLinkedCalendarControl(new URL("http://localhost"), {
        operation: "select",
        destination: null,
        expectedRevision: paused.revision,
        idempotencyKey: "replace-while-busy",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    expect((await h.controls().read()).destination).toEqual(destination);
  });

  it("keeps the public reconciliation path paused without initializing a provider", async () => {
    const h = await harness();
    const runtime = {
      ...h.runtime(),
      getService: () => {
        throw new Error("Provider must not be initialized while paused");
      },
    } as unknown as IAgentRuntime;
    const link = await new LinkedCalendarRepository(runtime).create({
      agentId: runtime.agentId,
      localEventId: "paused-event",
      ...destination,
      localRevision: 1,
    });
    const service = new CalendarService(runtime);
    const result = await service.executeLinkedCalendarReconciliation(link.id, {
      expectedUpdatedAt: link.updatedAt,
      idempotencyKey: "paused-review",
    });
    expect(result.outcome).toBe("paused");
    expect(result.link.pendingOperation).toBe("create");
  });

  it("refuses a configured but disconnected destination through the public service path", async () => {
    const h = await harness();
    let observeBootstrap!: (error: unknown) => void;
    const bootstrapFailure = new Promise<unknown>((resolve) => {
      observeBootstrap = resolve;
    });
    const runtime = {
      ...h.runtime(),
      reportError: (_scope: string, error: unknown) => observeBootstrap(error),
    } as unknown as IAgentRuntime;
    const link = await new LinkedCalendarRepository(runtime).create({
      agentId: runtime.agentId,
      localEventId: "disconnected-event",
      ...destination,
      localRevision: 1,
    });
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    await h.controls().resume(selected.revision);
    const service = new CalendarService(runtime);
    service.setGate({
      getGoogleConnectorAccounts: async () => [],
    } as unknown as CalendarHostGate);
    await expect(
      service.executeLinkedCalendarReconciliation(link.id, {
        expectedUpdatedAt: link.updatedAt,
        idempotencyKey: "disconnected-review",
      }),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
    });
    expect(await bootstrapFailure).toMatchObject({
      code: "LINKED_CALENDAR_DESTINATION_UNAVAILABLE",
    });
    expect((await h.controls().read()).dispatch).toBeNull();
    expect(
      (
        await new LinkedCalendarRepository(runtime).getById(
          runtime.agentId,
          link.id,
        )
      )?.pendingOperation,
    ).toBe("create");
  });

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
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "pending-event", destination);
    const paused = await h.controls().pause(active.revision);
    await h.pg.close();
    databases.splice(databases.indexOf(h.pg), 1);
    const reopened = await harness(directory);
    expect(await reopened.controls().read()).toEqual(paused);
    await expect(
      reopened.controls().resume(paused.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    await reopened.controls().settleDispatch(token);
    expect((await reopened.controls().resume(paused.revision)).paused).toBe(
      false,
    );
    await expect(
      reopened.controls().resume(selected.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
  });

  it("blocks new dispatch, destination change and resume until an admitted operation settles", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "event-a", destination);
    await expect(
      h.controls().acquireDispatch(active.revision, "event-b", destination),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
    const paused = await h.controls().pause(active.revision);
    await expect(
      h.controls().selectDestination(paused.revision, null),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    await expect(h.controls().resume(paused.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    await expect(
      h.controls().settleDispatch("unrelated-receipt"),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DISPATCH_RECEIPT_REJECTED",
    });
    await h.controls().settleDispatch(token);
    await expect(
      h.controls().acquireDispatch(paused.revision, "event-b", destination),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
    const resumed = await h.controls().resume(paused.revision);
    await expect(
      h.controls().acquireDispatch(resumed.revision, "event-b", {
        ...destination,
        providerCalendarId: "unselected-calendar",
      }),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
    const second = await h
      .controls()
      .acquireDispatch(resumed.revision, "event-b", destination);
    await h.controls().settleDispatch(second);
  });

  it("settles recovery only against the paused revision and invalidates old resume reviews", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const token = await h
      .controls()
      .acquireDispatch(active.revision, "recover-event", destination);
    await expect(
      h.controls().settleDispatch(token, active.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DISPATCH_RECEIPT_REJECTED",
    });
    const paused = await h.controls().pause(active.revision);
    await expect(
      h.controls().settleDispatch(token, active.revision),
    ).rejects.toMatchObject({
      code: "LINKED_CALENDAR_DISPATCH_RECEIPT_REJECTED",
    });
    expect((await h.controls().read()).dispatch?.token).toBe(token);
    await h.controls().settleDispatch(token, paused.revision);
    const recovered = await h.controls().read();
    expect(recovered.paused).toBe(true);
    expect(recovered.dispatch).toBeNull();
    await expect(h.controls().resume(paused.revision)).rejects.toMatchObject({
      code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED",
    });
    expect((await h.controls().resume(recovered.revision)).paused).toBe(false);
  });

  it("serializes a pause racing admission across independent repository instances", async () => {
    const h = await harness();
    const initial = await h.controls().read();
    const selected = await h
      .controls()
      .selectDestination(initial.revision, destination);
    const active = await h.controls().resume(selected.revision);
    const [admission, pause] = await Promise.allSettled([
      h
        .controls()
        .acquireDispatch(active.revision, "racing-event", destination),
      h.controls().pause(active.revision),
    ]);
    expect(pause.status).toBe("fulfilled");
    const current = await h.controls().read();
    expect(current.paused).toBe(true);
    if (admission.status === "fulfilled") {
      expect(current.dispatch?.token).toBe(admission.value);
      await expect(h.controls().resume(current.revision)).rejects.toMatchObject(
        { code: "LINKED_CALENDAR_CONTROL_TRANSITION_REJECTED" },
      );
      await h.controls().settleDispatch(admission.value);
    } else {
      expect(current.dispatch).toBeNull();
    }
    await expect(
      h
        .controls()
        .acquireDispatch(current.revision, "later-event", destination),
    ).rejects.toMatchObject({ code: "LINKED_CALENDAR_DISPATCH_REJECTED" });
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
