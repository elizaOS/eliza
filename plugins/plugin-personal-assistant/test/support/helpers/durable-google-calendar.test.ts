/** Verifies durable Google Calendar fixtures without a REST mock transport. */
import { afterEach, describe, expect, it } from "vitest";
import { seedDurableGoogleCalendar } from "./durable-google-calendar.ts";
import type { MockedTestRuntime } from "./mock-runtime.ts";
import { createMockedTestRuntime } from "./mock-runtime.ts";

describe("durable Google Calendar test fixtures", () => {
  let mocked: MockedTestRuntime | undefined;

  afterEach(async () => {
    await mocked?.cleanup();
    mocked = undefined;
  });

  it("seeds an explicitly granted read-only calendar snapshot", async () => {
    mocked = await createMockedTestRuntime({
      envs: [],
      seedX: false,
      seedBenchmarkFixtures: false,
      withLLM: false,
    });

    const repository = await seedDurableGoogleCalendar({
      runtime: mocked.runtime,
      grantId: "durable-calendar-test-grant",
      events: [
        {
          id: "durable-calendar-test-event",
          title: "Read-only fixture",
          startAt: "2026-08-12T09:00:00-04:00",
          endAt: "2026-08-12T10:00:00-04:00",
        },
      ],
    });

    const events = await repository.listCalendarEvents(
      String(mocked.runtime.agentId),
      "google",
      undefined,
      undefined,
      "owner",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "durable-calendar-test-event",
      grantId: "durable-calendar-test-grant",
      title: "Read-only fixture",
    });

    const grant = await repository.getConnectorGrant(
      String(mocked.runtime.agentId),
      "google",
      "local",
    );
    expect(grant?.id).toBe("durable-calendar-test-grant");
    expect(grant?.capabilities).toContain("google.calendar.read");
    expect(grant?.capabilities).not.toContain("google.calendar.write");
  });
});
