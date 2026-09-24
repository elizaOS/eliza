/**
 * Exercises explicit Google account authorization through real runtime services
 * and persistence. The local HTTP fixture observes forbidden dispatches; it
 * does not certify external Google account isolation.
 */
import { expect, test } from "bun:test";
import { getConnectorAccountManager } from "@elizaos/core";
import { CalendarRepository } from "../../../plugins/plugin-calendar/src/service/CalendarRepository.ts";
import { CalendarService } from "../../../plugins/plugin-calendar/src/service/CalendarService.ts";
import { LifeOpsService } from "../../../plugins/plugin-personal-assistant/src/lifeops/service.ts";
import { createMockedTestRuntime } from "../../../plugins/plugin-personal-assistant/test/support/helpers/mock-runtime.ts";
import { seedGoogleConnectorGrant } from "../../../plugins/plugin-personal-assistant/test/support/helpers/seed-grants.ts";

test("explicit read-only and revoked accounts cannot write or fall back to another account", async () => {
  const fixture = await createMockedTestRuntime({
    envs: ["google"],
    seedGoogle: false,
    seedX: false,
    seedBenchmarkFixtures: false,
    withLLM: false,
  });
  try {
    const { runtime, mocks } = fixture;
    await seedGoogleConnectorGrant(runtime, {
      email: "readonly@example.test",
      capabilities: ["google.calendar.read"],
    });
    await seedGoogleConnectorGrant(runtime, {
      email: "writable@example.test",
      capabilities: ["google.calendar.read", "google.calendar.write"],
    });
    const manager = getConnectorAccountManager(runtime);
    const accounts = await manager.listAccounts("google");
    const readonly = accounts.find(
      (account) => account.externalId === "readonly@example.test",
    );
    const writable = accounts.find(
      (account) => account.externalId === "writable@example.test",
    );
    if (!readonly || !writable)
      throw new Error("Expected both seeded connector accounts");
    const calendar = await runtime.getServiceLoadPromise("calendar");
    if (!(calendar instanceof CalendarService))
      throw new Error("Expected real Calendar service");
    const lifeops = new LifeOpsService(runtime);
    const url = new URL("http://localhost/api/calendar");
    const readonlyGrant = `connector-account:${readonly.id}`;
    const writableGrant = `connector-account:${writable.id}`;
    const readGrant = await lifeops.requireGoogleCalendarGrant(
      url,
      "local",
      "owner",
      readonlyGrant,
    );
    expect(readGrant.identity.email).toBe("readonly@example.test");
    const allowed = await lifeops.requireGoogleCalendarWriteGrant(
      url,
      "local",
      "owner",
      writableGrant,
    );
    expect(allowed.identity.email).toBe("writable@example.test");
    const repo = new CalendarRepository(runtime);
    const before = await repo.listCalendarEvents(runtime.agentId, "eliza");
    const request = {
      title: "Permission boundary focus block",
      calendarId: "primary",
      startAt: "2027-02-03T15:00:00Z",
      endAt: "2027-02-03T15:30:00Z",
      timeZone: "UTC",
      grantId: readonlyGrant,
    };
    mocks.clearRequestLedger();
    await expect(
      calendar.createCalendarEventMutation(url, request),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      mocks.requestLedger().filter((entry) => entry.path.includes("/events")),
    ).toEqual([]);
    await manager.patchAccount("google", writable.id, { status: "revoked" });
    await expect(
      lifeops.requireGoogleCalendarGrant(url, "local", "owner", writableGrant),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      calendar.createCalendarEventMutation(url, {
        ...request,
        grantId: writableGrant,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      mocks.requestLedger().filter((entry) => entry.path.includes("/events")),
    ).toEqual([]);
    expect(await repo.listCalendarEvents(runtime.agentId, "eliza")).toEqual(
      before,
    );
    expect(
      (
        await lifeops.requireGoogleCalendarGrant(
          url,
          "local",
          "owner",
          readonlyGrant,
        )
      ).identity.email,
    ).toBe("readonly@example.test");
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
