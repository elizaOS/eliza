import { readLifeOpsOwnerProfile } from "@elizaos/app-lifeops/lifeops/owner-profile";
import { LifeOpsService } from "@elizaos/app-lifeops/lifeops/service";
import { afterEach, describe, expect, it } from "vitest";
import { createMockedTestRuntime } from "../helpers/mock-runtime.ts";
import { seedTestUserProfile } from "../helpers/seed-test-user-profile.ts";

const INTERNAL_URL = new URL("http://127.0.0.1:31337");
const SEEDED_OWNER_NAME = "Eliza Test Owner";

async function withLoadTestUserProfileFlag<T>(
  value: "1" | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = process.env.LOAD_TEST_USER_PROFILE;
  if (value === undefined) {
    delete process.env.LOAD_TEST_USER_PROFILE;
  } else {
    process.env.LOAD_TEST_USER_PROFILE = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.LOAD_TEST_USER_PROFILE;
    } else {
      process.env.LOAD_TEST_USER_PROFILE = previous;
    }
  }
}

describe("mock runtime seeding", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it("seeds a connected Google grant with canonical capabilities and an empty calendar by default", async () => {
    const mocked = await createMockedTestRuntime({
      envs: ["google"],
      seedX: false,
    });
    cleanups.push(mocked.cleanup);

    const service = new LifeOpsService(mocked.runtime);
    const status = await service.getGoogleConnectorStatus(INTERNAL_URL);
    expect(status.connected).toBe(true);
    expect(status.grantedCapabilities).toEqual(
      expect.arrayContaining([
        "google.basic_identity",
        "google.calendar.read",
        "google.calendar.write",
        "google.gmail.triage",
        "google.gmail.send",
      ]),
    );

    const [triage, calendarResponse] = await Promise.all([
      service.getGmailTriage(INTERNAL_URL, { maxResults: 4, forceSync: true }),
      fetch(
        `${process.env.ELIZA_MOCK_GOOGLE_BASE}/calendar/v3/calendars/primary/events?${new URLSearchParams(
          {
            singleEvents: "true",
            orderBy: "startTime",
            showDeleted: "false",
            maxResults: "50",
            timeMin: new Date().toISOString(),
            timeMax: new Date(
              Date.now() + 7 * 24 * 60 * 60 * 1000,
            ).toISOString(),
            fields:
              "items(id,status,summary,description,location,htmlLink,hangoutLink,iCalUID,recurringEventId,created,updated,start,end,organizer(email,displayName,self),attendees(email,displayName,responseStatus,self,organizer,optional),conferenceData(entryPoints(uri,label,entryPointType)))",
          },
        )}`,
      ).then(
        (response) =>
          response.json() as Promise<{
            items?: Array<{ summary?: string }>;
          }>,
      ),
    ]);

    expect(triage.messages.map((message) => message.subject)).toEqual(
      expect.arrayContaining([
        "Invoice 4831 received",
        "Can you review the product brief?",
      ]),
    );
    expect(calendarResponse.items ?? []).toEqual([]);
  });

  it("seeds side-specific X connector grants when the X mock is enabled", async () => {
    const mocked = await createMockedTestRuntime({
      envs: ["x-twitter"],
      seedGoogle: false,
    });
    cleanups.push(mocked.cleanup);

    const service = new LifeOpsService(mocked.runtime);
    const ownerStatus = await service.getXConnectorStatus("local", "owner");
    expect(ownerStatus.connected).toBe(true);
    expect(ownerStatus.grantedCapabilities).toEqual(
      expect.arrayContaining(["x.read", "x.dm.read", "x.dm.write"]),
    );
    expect(ownerStatus.grantedCapabilities).not.toContain("x.write");

    const agentStatus = await service.getXConnectorStatus("local", "agent");
    expect(agentStatus.connected).toBe(true);
    expect(agentStatus.grantedCapabilities).toEqual(
      expect.arrayContaining(["x.read", "x.write"]),
    );
  });

  it("seeds local relationships and screen-time fixtures for benchmark runs", async () => {
    const mocked = await createMockedTestRuntime({
      envs: ["google"],
      seedX: false,
    });
    cleanups.push(mocked.cleanup);

    const service = new LifeOpsService(mocked.runtime);
    const today = new Date().toISOString().slice(0, 10);
    const [relationships, daily] = await Promise.all([
      service.listRelationships({ limit: 10 }),
      service.getScreenTimeDaily({ date: today, limit: 10 }),
    ]);

    expect(relationships.map((relationship) => relationship.name)).toEqual(
      expect.arrayContaining(["David Park", "Marcus Walters", "Jane Patel"]),
    );
    expect(daily.length).toBeGreaterThan(0);
    expect(daily.map((row) => row.identifier)).toEqual(
      expect.arrayContaining(["com.apple.Safari", "com.microsoft.VSCode"]),
    );
  });

  it("does not seed the test user profile when LOAD_TEST_USER_PROFILE is off", async () => {
    await withLoadTestUserProfileFlag(undefined, async () => {
      const mocked = await createMockedTestRuntime({
        envs: ["google"],
        seedX: false,
      });
      cleanups.push(mocked.cleanup);

      const service = new LifeOpsService(mocked.runtime);
      const [profile, definitions] = await Promise.all([
        readLifeOpsOwnerProfile(mocked.runtime),
        service.listDefinitions(),
      ]);

      expect(profile.name).not.toBe(SEEDED_OWNER_NAME);
      expect(definitions.map((entry) => entry.definition.title)).not.toContain(
        "Invisalign",
      );
    });
  });

  it("seeds the test user profile and LifeOps routines when LOAD_TEST_USER_PROFILE is on", async () => {
    await withLoadTestUserProfileFlag("1", async () => {
      const mocked = await createMockedTestRuntime({
        envs: ["google"],
        seedX: false,
      });
      cleanups.push(mocked.cleanup);

      const service = new LifeOpsService(mocked.runtime);
      const profile = await readLifeOpsOwnerProfile(mocked.runtime);
      expect(profile.name).toBe(SEEDED_OWNER_NAME);
      expect(profile.location).toBe("Test City, CA");

      const definitions = await service.listDefinitions();
      const seededDefinitions = definitions.filter((entry) =>
        String(entry.definition.metadata?.seedKey ?? "").startsWith(
          "load-test-user-profile:",
        ),
      );
      const seededTitles = seededDefinitions.map(
        (entry) => entry.definition.title,
      );

      expect(seededTitles).toEqual(
        expect.arrayContaining([
          "Brush teeth",
          "Invisalign",
          "Stretch",
          "Take vitamins",
          "Workout",
        ]),
      );
      expect(seededDefinitions).toHaveLength(5);
      expect(
        new Set(
          seededDefinitions.map((entry) => entry.definition.metadata.seedKey),
        ).size,
      ).toBe(5);

      await seedTestUserProfile(mocked.runtime);

      const rerunDefinitions = await service.listDefinitions();
      const rerunSeededDefinitions = rerunDefinitions.filter((entry) =>
        String(entry.definition.metadata?.seedKey ?? "").startsWith(
          "load-test-user-profile:",
        ),
      );

      expect(rerunSeededDefinitions).toHaveLength(5);
      expect(
        new Set(
          rerunSeededDefinitions.map(
            (entry) => entry.definition.metadata.seedKey,
          ),
        ).size,
      ).toBe(5);
    });
  });
});
