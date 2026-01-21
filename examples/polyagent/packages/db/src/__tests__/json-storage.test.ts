/**
 * JSON Storage Backend Tests
 *
 * Tests the JSON storage mode to ensure it mirrors the PostgreSQL interface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  db,
  getStorageMode,
  initializeJsonMode,
  isSimulationMode,
  resetToPostgresMode,
} from "../index";

describe("JSON Storage Backend", () => {
  beforeEach(async () => {
    // Use random suffix to avoid state collision
    await initializeJsonMode(
      "/tmp/polyagent-test-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2),
    );
  });

  afterEach(() => {
    resetToPostgresMode();
  });

  test("initializes in JSON mode", () => {
    expect(getStorageMode()).toBe("json");
    expect(isSimulationMode()).toBe(true);
  });

  test("creates and finds records", async () => {
    const user = await db.user.create({
      data: {
        id: "test-user-1",
        username: "testuser",
        displayName: "Test User",
        virtualBalance: "1000",
        totalDeposited: "0",
        reputationPoints: 100,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    expect(user.id).toBe("test-user-1");
    expect(user.username).toBe("testuser");

    const found = await db.user.findUnique({
      where: { id: "test-user-1" },
    });

    expect(found).not.toBeNull();
    expect(found?.username).toBe("testuser");
  });

  test("findMany with where clause", async () => {
    await db.user.create({
      data: {
        id: "user-1",
        username: "user1",
        displayName: "User 1",
        virtualBalance: "100",
        totalDeposited: "0",
        reputationPoints: 10,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    await db.user.create({
      data: {
        id: "user-2",
        username: "user2",
        displayName: "User 2",
        virtualBalance: "200",
        totalDeposited: "0",
        reputationPoints: 20,
        lifetimePnL: "0",
        isAgent: true,
        role: "agent",
      },
    });

    const agents = await db.user.findMany({
      where: { isAgent: true },
    });

    expect(agents.length).toBe(1);
    expect(agents[0]?.id).toBe("user-2");
  });

  test("supports Date comparisons in where clauses", async () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const t1 = new Date("2026-01-01T01:00:00.000Z");
    const cutoff = new Date("2026-01-01T00:30:00.000Z");

    await db.user.create({
      data: {
        id: "date-user-0",
        username: "date0",
        displayName: "Date 0",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
        createdAt: t0,
      },
    });

    await db.user.create({
      data: {
        id: "date-user-1",
        username: "date1",
        displayName: "Date 1",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
        createdAt: t1,
      },
    });

    const recent = await db.user.findMany({
      where: { createdAt: { gte: cutoff } },
      orderBy: { createdAt: "asc" },
    });

    expect(recent.map((u) => u.id)).toEqual(["date-user-1"]);
  });

  test("updates records", async () => {
    await db.user.create({
      data: {
        id: "user-to-update",
        username: "original",
        displayName: "Original",
        virtualBalance: "100",
        totalDeposited: "0",
        reputationPoints: 10,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    const updated = await db.user.update({
      where: { id: "user-to-update" },
      data: { displayName: "Updated Name" },
    });

    expect(updated.displayName).toBe("Updated Name");
    expect(updated.username).toBe("original");
  });

  test("deletes records", async () => {
    await db.user.create({
      data: {
        id: "user-to-delete",
        username: "deleteme",
        displayName: "Delete Me",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    await db.user.delete({
      where: { id: "user-to-delete" },
    });

    const found = await db.user.findUnique({
      where: { id: "user-to-delete" },
    });

    expect(found).toBeNull();
  });

  test("counts records", async () => {
    await db.user.create({
      data: {
        id: "count-1",
        username: "count1",
        displayName: "Count 1",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    await db.user.create({
      data: {
        id: "count-2",
        username: "count2",
        displayName: "Count 2",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    const count = await db.user.count();
    expect(count).toBe(2);
  });

  test("upserts records", async () => {
    // First upsert creates
    const created = await db.user.upsert({
      where: { id: "upsert-user" },
      create: {
        id: "upsert-user",
        username: "upserted",
        displayName: "Created",
        virtualBalance: "100",
        totalDeposited: "0",
        reputationPoints: 10,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
      update: { displayName: "Updated" },
    });

    expect(created.displayName).toBe("Created");

    // Second upsert updates
    const updated = await db.user.upsert({
      where: { id: "upsert-user" },
      create: {
        id: "upsert-user",
        username: "upserted",
        displayName: "Created",
        virtualBalance: "100",
        totalDeposited: "0",
        reputationPoints: 10,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
      update: { displayName: "Updated" },
    });

    expect(updated.displayName).toBe("Updated");
  });

  test("sorts results", async () => {
    await db.user.create({
      data: {
        id: "sort-a",
        username: "a_first",
        displayName: "A",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 30,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    await db.user.create({
      data: {
        id: "sort-b",
        username: "b_second",
        displayName: "B",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 10,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    await db.user.create({
      data: {
        id: "sort-c",
        username: "c_third",
        displayName: "C",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 20,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    const sorted = await db.user.findMany({
      orderBy: { reputationPoints: "desc" },
    });

    expect(sorted[0]?.reputationPoints).toBe(30);
    expect(sorted[1]?.reputationPoints).toBe(20);
    expect(sorted[2]?.reputationPoints).toBe(10);
  });

  test("handles take and skip", async () => {
    for (let i = 0; i < 5; i++) {
      await db.user.create({
        data: {
          id: `pagination-${i}`,
          username: `page${i}`,
          displayName: `Page ${i}`,
          virtualBalance: "0",
          totalDeposited: "0",
          reputationPoints: i,
          lifetimePnL: "0",
          isAgent: false,
          role: "user",
        },
      });
    }

    const page = await db.user.findMany({
      take: 2,
      skip: 1,
      orderBy: { reputationPoints: "asc" },
    });

    expect(page.length).toBe(2);
    expect(page[0]?.reputationPoints).toBe(1);
    expect(page[1]?.reputationPoints).toBe(2);
  });
});

describe("Question Arc Plans in JSON Mode", () => {
  beforeEach(async () => {
    await initializeJsonMode(`/tmp/polyagent-arc-test-${Date.now()}`);
  });

  afterEach(() => {
    resetToPostgresMode();
  });

  test("creates and retrieves arc plans", async () => {
    // First create a question
    await db.question.create({
      data: {
        id: "test-question-1",
        questionNumber: 1,
        text: "Will it rain tomorrow?",
        scenarioId: 1,
        outcome: true,
        rank: 1,
        resolutionDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        status: "active",
      },
    });

    // Create arc plan
    const arcPlan = await db.questionArcPlan.create({
      data: {
        id: "arc-plan-1",
        questionId: "test-question-1",
        uncertaintyPeakDay: 10,
        clarityOnsetDay: 20,
        verificationDay: 28,
        insiderActorIds: ["actor-1", "actor-2"],
        deceiverActorIds: ["actor-3"],
        phaseRatios: { early: 0.4, middle: 0.6, late: 0.75, climax: 1.0 },
      },
    });

    expect(arcPlan.uncertaintyPeakDay).toBe(10);
    expect(arcPlan.insiderActorIds).toEqual(["actor-1", "actor-2"]);

    // Retrieve
    const found = await db.questionArcPlan.findFirst({
      where: { questionId: "test-question-1" },
    });

    expect(found).not.toBeNull();
    expect(found?.clarityOnsetDay).toBe(20);
  });
});

describe("Complex Queries in JSON Mode", () => {
  beforeEach(async () => {
    // Use random suffix to avoid state collision
    await initializeJsonMode(
      "/tmp/polyagent-complex-test-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2),
    );
  });

  afterEach(() => {
    resetToPostgresMode();
  });

  test("handles multiple tables (posts and users)", async () => {
    // Create user
    const user = await db.user.create({
      data: {
        id: "author-1",
        username: "author",
        displayName: "Author",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 100,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    // Create posts
    await db.post.create({
      data: {
        id: "post-1",
        content: "First post",
        authorId: user.id,
        authorType: "user",
        postType: "status",
        visibility: "public",
      },
    });

    await db.post.create({
      data: {
        id: "post-2",
        content: "Second post",
        authorId: user.id,
        authorType: "user",
        postType: "status",
        visibility: "public",
      },
    });

    // Query posts by author
    const posts = await db.post.findMany({
      where: { authorId: "author-1" },
    });

    expect(posts.length).toBe(2);
  });

  test("handles increment operations", async () => {
    await db.user.create({
      data: {
        id: "increment-user",
        username: "incrementer",
        displayName: "Incrementer",
        virtualBalance: "100",
        totalDeposited: "0",
        reputationPoints: 50,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    const updated = await db.user.update({
      where: { id: "increment-user" },
      data: { reputationPoints: { increment: 25 } },
    });

    expect(updated.reputationPoints).toBe(75);
  });

  test("handles decrement operations", async () => {
    await db.user.create({
      data: {
        id: "decrement-user",
        username: "decrementer",
        displayName: "Decrementer",
        virtualBalance: "100",
        totalDeposited: "0",
        reputationPoints: 50,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    const updated = await db.user.update({
      where: { id: "decrement-user" },
      data: { reputationPoints: { decrement: 10 } },
    });

    expect(updated.reputationPoints).toBe(40);
  });

  test("handles updateMany", async () => {
    await db.user.create({
      data: {
        id: "batch-1",
        username: "batch1",
        displayName: "Batch 1",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: true,
        role: "agent",
      },
    });

    await db.user.create({
      data: {
        id: "batch-2",
        username: "batch2",
        displayName: "Batch 2",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: true,
        role: "agent",
      },
    });

    const result = await db.user.updateMany({
      where: { isAgent: true },
      data: { reputationPoints: 100 },
    });

    expect(result.count).toBe(2);

    const agents = await db.user.findMany({ where: { isAgent: true } });
    expect(agents.every((a) => a.reputationPoints === 100)).toBe(true);
  });

  test("handles deleteMany", async () => {
    await db.user.create({
      data: {
        id: "delete-batch-1",
        username: "deletebatch1",
        displayName: "Delete Batch 1",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: true,
        role: "agent",
      },
    });

    await db.user.create({
      data: {
        id: "delete-batch-2",
        username: "deletebatch2",
        displayName: "Delete Batch 2",
        virtualBalance: "0",
        totalDeposited: "0",
        reputationPoints: 0,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    const result = await db.user.deleteMany({
      where: { isAgent: true },
    });

    expect(result.count).toBe(1);

    const remaining = await db.user.findMany();
    expect(remaining.length).toBe(1);
    expect(remaining[0]?.isAgent).toBe(false);
  });

  test("handles createMany", async () => {
    const result = await db.user.createMany({
      data: [
        {
          id: "create-many-1",
          username: "createmany1",
          displayName: "Create Many 1",
          virtualBalance: "0",
          totalDeposited: "0",
          reputationPoints: 0,
          lifetimePnL: "0",
          isAgent: false,
          role: "user",
        },
        {
          id: "create-many-2",
          username: "createmany2",
          displayName: "Create Many 2",
          virtualBalance: "0",
          totalDeposited: "0",
          reputationPoints: 0,
          lifetimePnL: "0",
          isAgent: false,
          role: "user",
        },
      ],
    });

    expect(result.count).toBe(2);

    const all = await db.user.findMany();
    expect(all.length).toBe(2);
  });
});

describe("Snapshot Operations", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir =
      "/tmp/polyagent-snapshot-test-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2);
    await initializeJsonMode(testDir);
  });

  afterEach(() => {
    resetToPostgresMode();
  });

  test("saves and loads snapshots", async () => {
    const { saveJsonSnapshot, getJsonState } = await import("../json-storage");

    // Create some data
    await db.user.create({
      data: {
        id: "snapshot-user",
        username: "snapshotuser",
        displayName: "Snapshot User",
        virtualBalance: "500",
        totalDeposited: "0",
        reputationPoints: 75,
        lifetimePnL: "0",
        isAgent: false,
        role: "user",
      },
    });

    // Save snapshot
    await saveJsonSnapshot();

    // Verify state exists
    const state = getJsonState();
    expect(state).not.toBeNull();
    expect(state?.tables.users).toBeDefined();

    // Reset and reload
    resetToPostgresMode();
    await initializeJsonMode(testDir);

    // Verify data is restored
    const user = await db.user.findUnique({
      where: { id: "snapshot-user" },
    });

    expect(user).not.toBeNull();
    expect(user?.username).toBe("snapshotuser");
  });
});
