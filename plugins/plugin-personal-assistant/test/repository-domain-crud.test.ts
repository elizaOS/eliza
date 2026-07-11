/** Real PGlite coverage for the LifeOps repository's domain CRUD contracts. */

import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsAuditEvent,
  createLifeOpsBrowserSession,
  createLifeOpsCalendarSyncState,
  createLifeOpsChannelPolicy,
  createLifeOpsConnectorGrant,
  createLifeOpsGmailSyncState,
  createLifeOpsGoalDefinition,
  createLifeOpsHealthMetricSample,
  createLifeOpsHealthSleepEpisode,
  createLifeOpsHealthSyncState,
  createLifeOpsHealthWorkout,
  createLifeOpsReminderAttempt,
  createLifeOpsReminderPlan,
  createLifeOpsTaskDefinition,
  createLifeOpsWebsiteAccessGrant,
  createLifeOpsWorkflowDefinition,
  createLifeOpsWorkflowRun,
  LifeOpsRepository,
} from "../src/lifeops/repository.ts";
import type { RealTestRuntimeResult } from "./helpers/runtime.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

const NOW = "2026-07-11T08:00:00.000Z";
const LATER = "2026-07-11T09:00:00.000Z";

function ownership(agentId: string) {
  return {
    agentId,
    domain: "user_lifeops" as const,
    subjectType: "owner" as const,
    subjectId: agentId,
    visibilityScope: "owner_only" as const,
    contextPolicy: "explicit_only" as const,
  };
}

describe("LifeOpsRepository domain CRUD", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("round-trips core owner records through the bootstrapped schema", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const base = ownership(runtime.agentId);

    const definition = createLifeOpsTaskDefinition({
      ...base,
      kind: "reminder",
      title: "Review inbox",
      description: "Review messages before standup",
      originalIntent: "Remind me to review messages",
      timezone: "UTC",
      status: "active",
      priority: 2,
      cadence: { kind: "once", dueAt: LATER },
      windowPolicy: { timezone: "UTC", windows: [] },
      progressionRule: { kind: "none" },
      websiteAccess: null,
      reminderPlanId: null,
      goalId: null,
      source: "manual",
      metadata: { source: "repository-domain-crud" },
    });
    await repository.createDefinition(definition);
    expect(
      await repository.getDefinition(runtime.agentId, definition.id),
    ).toMatchObject({
      id: definition.id,
      title: "Review inbox",
    });
    expect(
      await repository.listActiveDefinitions(runtime.agentId),
    ).toHaveLength(1);
    await repository.updateDefinition({
      ...definition,
      title: "Review priority inbox",
      updatedAt: LATER,
    });
    expect(await repository.listDefinitions(runtime.agentId)).toEqual([
      expect.objectContaining({ title: "Review priority inbox" }),
    ]);

    const occurrence = {
      id: crypto.randomUUID(),
      ...base,
      definitionId: definition.id,
      occurrenceKey: "2026-07-11",
      scheduledAt: NOW,
      dueAt: LATER,
      relevanceStartAt: NOW,
      relevanceEndAt: "2026-07-11T10:00:00.000Z",
      windowName: "morning",
      state: "visible" as const,
      snoozedUntil: null,
      completionPayload: null,
      derivedTarget: { channel: "chat" },
      metadata: { seededBy: "test" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repository.upsertOccurrence(occurrence);
    expect(
      await repository.listOccurrencesForDefinition(
        runtime.agentId,
        definition.id,
      ),
    ).toHaveLength(1);
    expect(
      await repository.listOccurrencesForDefinitions(runtime.agentId, [
        definition.id,
      ]),
    ).toHaveLength(1);
    expect(
      await repository.getOccurrence(runtime.agentId, occurrence.id),
    ).toMatchObject({
      id: occurrence.id,
      derivedTarget: { channel: "chat" },
    });
    expect(
      await repository.getOccurrenceView(runtime.agentId, occurrence.id),
    ).toMatchObject({
      id: occurrence.id,
      title: "Review priority inbox",
    });
    expect(
      await repository.listOccurrenceViewsForOverview(
        runtime.agentId,
        "2026-07-12T00:00:00.000Z",
      ),
    ).toHaveLength(1);
    await repository.updateOccurrence({
      ...occurrence,
      state: "completed",
      completionPayload: { ok: true },
      updatedAt: LATER,
    });

    const goal = createLifeOpsGoalDefinition({
      ...base,
      title: "Stay ahead",
      description: "Keep the owner ahead of commitments",
      cadence: { kind: "weekly" },
      supportStrategy: { kind: "nudge" },
      successCriteria: { metric: "zero-overdue" },
      status: "active",
      reviewState: "on_track",
      metadata: { lane: "crud" },
    });
    await repository.createGoal(goal);
    await repository.updateGoal({
      ...goal,
      title: "Stay ahead daily",
      updatedAt: LATER,
    });
    expect(await repository.getGoal(runtime.agentId, goal.id)).toMatchObject({
      title: "Stay ahead daily",
    });
    expect(await repository.listGoals(runtime.agentId)).toHaveLength(1);
    const goalLink = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      goalId: goal.id,
      linkedType: "definition" as const,
      linkedId: definition.id,
      createdAt: NOW,
    };
    await repository.upsertGoalLink(goalLink);
    expect(
      await repository.listGoalLinksForGoal(runtime.agentId, goal.id),
    ).toEqual([expect.objectContaining({ linkedId: definition.id })]);
    await repository.deleteGoalLinksForLinked(
      runtime.agentId,
      "definition",
      definition.id,
    );
    expect(
      await repository.listGoalLinksForGoal(runtime.agentId, goal.id),
    ).toEqual([]);

    const reminderPlan = createLifeOpsReminderPlan({
      agentId: runtime.agentId,
      ownerType: "definition",
      ownerId: definition.id,
      steps: [{ channel: "chat", delayMinutes: 0 }],
      mutePolicy: { kind: "none" },
      quietHours: { enabled: false },
    });
    await repository.createReminderPlan(reminderPlan);
    await repository.updateReminderPlan({
      ...reminderPlan,
      steps: [{ channel: "chat", delayMinutes: 5 }],
      updatedAt: LATER,
    });
    expect(
      await repository.getReminderPlan(runtime.agentId, reminderPlan.id),
    ).toMatchObject({
      steps: [{ channel: "chat", delayMinutes: 5 }],
    });
    expect(
      await repository.listReminderPlansForOwners(
        runtime.agentId,
        "definition",
        [definition.id],
      ),
    ).toHaveLength(1);

    const auditEvent = createLifeOpsAuditEvent({
      agentId: runtime.agentId,
      eventType: "decision",
      ownerType: "definition",
      ownerId: definition.id,
      reason: "test coverage",
      inputs: { occurrenceId: occurrence.id },
      decision: { accepted: true },
      actor: "agent",
    });
    expect(await repository.createAuditEventIfNew(auditEvent)).toBe(true);
    expect(await repository.createAuditEventIfNew(auditEvent)).toBe(false);
    expect(
      await repository.listAuditEvents(
        runtime.agentId,
        "definition",
        definition.id,
      ),
    ).toEqual([expect.objectContaining({ id: auditEvent.id })]);

    const channelPolicy = createLifeOpsChannelPolicy({
      agentId: runtime.agentId,
      channelType: "chat",
      channelRef: "owner-room",
      privacyClass: "private",
      allowReminders: true,
      allowEscalation: false,
      allowPosts: true,
      requireConfirmationForActions: true,
      metadata: { owner: true },
    });
    await repository.upsertChannelPolicy(channelPolicy);
    expect(
      await repository.getChannelPolicy(runtime.agentId, "chat", "owner-room"),
    ).toMatchObject({
      allowReminders: true,
    });
    expect(await repository.listChannelPolicies(runtime.agentId)).toHaveLength(
      1,
    );

    const websiteGrant = createLifeOpsWebsiteAccessGrant({
      agentId: runtime.agentId,
      groupKey: "focus",
      definitionId: definition.id,
      occurrenceId: occurrence.id,
      websites: ["example.com"],
      unlockMode: "fixed_duration",
      unlockDurationMinutes: 15,
      callbackKey: "cb-1",
      unlockedAt: NOW,
      expiresAt: LATER,
      revokedAt: null,
      metadata: { reason: "research" },
    });
    await repository.upsertWebsiteAccessGrant(websiteGrant);
    expect(
      await repository.listWebsiteAccessGrants(runtime.agentId),
    ).toHaveLength(1);
    await repository.revokeWebsiteAccessGrants(runtime.agentId, {
      groupKey: "focus",
      revokedAt: LATER,
    });
    expect(await repository.listWebsiteAccessGrants(runtime.agentId)).toEqual([
      expect.objectContaining({ revokedAt: LATER }),
    ]);

    const grant = createLifeOpsConnectorGrant({
      agentId: runtime.agentId,
      provider: "gmail",
      connectorAccountId: null,
      identity: { email: "Owner@Example.com" },
      grantedScopes: ["gmail.readonly"],
      capabilities: ["read"],
      tokenRef: "vault:gmail",
      mode: "oauth",
      metadata: { label: "owner gmail" },
      lastRefreshAt: NOW,
    });
    await repository.upsertConnectorGrant(grant);
    expect(await repository.listConnectorGrants(runtime.agentId)).toEqual([
      expect.objectContaining({
        provider: "gmail",
        identityEmail: "owner@example.com",
      }),
    ]);
    const reloadedGrant = await repository.getConnectorGrant(
      runtime.agentId,
      "gmail",
      "oauth",
    );
    expect(reloadedGrant?.connectorAccountId).toBeTruthy();
    expect(
      await repository.listConnectorAccountPrivacy(runtime.agentId),
    ).toEqual([expect.objectContaining({ provider: "gmail" })]);

    const workflow = createLifeOpsWorkflowDefinition({
      ...base,
      title: "Research purchase",
      triggerType: "manual",
      schedule: { kind: "manual" },
      actionPlan: { steps: ["open browser"] },
      permissionPolicy: { mode: "ask" },
      status: "active",
      createdBy: "agent",
      metadata: { domain: "shopping" },
    });
    await repository.createWorkflow(workflow);
    await repository.updateWorkflow({
      ...workflow,
      title: "Research laptop",
      updatedAt: LATER,
    });
    expect(
      await repository.getWorkflow(runtime.agentId, workflow.id),
    ).toMatchObject({
      title: "Research laptop",
    });
    expect(await repository.listWorkflows(runtime.agentId)).toHaveLength(1);
    const run = createLifeOpsWorkflowRun({
      agentId: runtime.agentId,
      workflowId: workflow.id,
      startedAt: NOW,
      finishedAt: LATER,
      status: "completed",
      result: { ok: true },
      auditRef: auditEvent.id,
    });
    await repository.createWorkflowRun(run);
    expect(
      await repository.listWorkflowRuns(runtime.agentId, workflow.id),
    ).toEqual([expect.objectContaining({ id: run.id })]);

    const attempt = createLifeOpsReminderAttempt({
      agentId: runtime.agentId,
      planId: reminderPlan.id,
      ownerType: "definition",
      ownerId: definition.id,
      occurrenceId: occurrence.id,
      channel: "chat",
      stepIndex: 0,
      scheduledFor: NOW,
      attemptedAt: LATER,
      outcome: "delivered",
      connectorRef: "chat:owner-room",
      deliveryMetadata: { source: "repository-domain-crud" },
      reviewAt: LATER,
      reviewStatus: "pending",
    });
    await repository.createReminderAttempt(attempt);
    expect(
      await repository.listReminderAttempts(runtime.agentId, {
        ownerType: "definition",
        ownerId: definition.id,
        planId: reminderPlan.id,
      }),
    ).toEqual([expect.objectContaining({ reviewAt: LATER })]);

    const browserSession = createLifeOpsBrowserSession({
      ...base,
      workflowId: workflow.id,
      browser: "chromium",
      companionId: "companion-1",
      profileId: "profile-1",
      windowId: "window-1",
      tabId: "tab-1",
      title: "Laptop research",
      status: "running",
      actions: [{ type: "navigate", url: "https://example.com" }],
      currentActionIndex: 0,
      awaitingConfirmationForActionId: null,
      result: {},
      metadata: { source: "test" },
      finishedAt: null,
    });
    await repository.createBrowserSession(browserSession);
    await repository.updateBrowserSession({
      ...browserSession,
      status: "completed",
      currentActionIndex: 1,
      result: { ok: true },
      finishedAt: LATER,
      updatedAt: LATER,
    });
    expect(
      await repository.getBrowserSession(runtime.agentId, browserSession.id),
    ).toMatchObject({
      status: "completed",
    });
    expect(await repository.listBrowserSessions(runtime.agentId)).toHaveLength(
      1,
    );

    const healthSample = createLifeOpsHealthMetricSample({
      agentId: runtime.agentId,
      provider: "healthkit",
      grantId: "health-grant",
      metric: "heart_rate",
      value: 72,
      unit: "bpm",
      startAt: NOW,
      endAt: NOW,
      localDate: "2026-07-11",
      sourceExternalId: "hr-1",
      metadata: { source: "watch" },
    });
    await repository.upsertHealthMetricSample(healthSample);
    expect(
      await repository.listHealthMetricSamples(runtime.agentId, {
        provider: "healthkit",
        metrics: ["heart_rate"],
        startDate: "2026-07-11",
        endDate: "2026-07-11",
        limit: 5,
      }),
    ).toEqual([expect.objectContaining({ value: 72 })]);

    const workout = createLifeOpsHealthWorkout({
      agentId: runtime.agentId,
      provider: "healthkit",
      grantId: "health-grant",
      sourceExternalId: "workout-1",
      workoutType: "walking",
      title: "Walk",
      startAt: NOW,
      endAt: LATER,
      durationSeconds: 3600,
      distanceMeters: 3000,
      calories: 180,
      averageHeartRate: 98,
      maxHeartRate: 120,
      metadata: { route: "park" },
    });
    await repository.upsertHealthWorkout(workout);
    expect(
      await repository.listHealthWorkouts(runtime.agentId, {
        provider: "healthkit",
        startDate: "2026-07-11",
        endDate: "2026-07-11",
      }),
    ).toEqual([expect.objectContaining({ workoutType: "walking" })]);

    const sleepEpisode = createLifeOpsHealthSleepEpisode({
      agentId: runtime.agentId,
      provider: "healthkit",
      grantId: "health-grant",
      sourceExternalId: "sleep-1",
      localDate: "2026-07-11",
      timezone: "UTC",
      startAt: "2026-07-10T23:00:00.000Z",
      endAt: "2026-07-11T07:00:00.000Z",
      isMainSleep: true,
      sleepType: "asleep",
      durationSeconds: 28_800,
      timeInBedSeconds: 30_000,
      efficiency: 0.92,
      latencySeconds: 900,
      awakeSeconds: 1200,
      lightSleepSeconds: 14_000,
      deepSleepSeconds: 6000,
      remSleepSeconds: 7600,
      sleepScore: 84,
      readinessScore: 80,
      averageHeartRate: 58,
      lowestHeartRate: 49,
      averageHrvMs: 64,
      respiratoryRate: 14,
      bloodOxygenPercent: 98,
      stageSamples: [{ stage: "deep", startAt: NOW, endAt: LATER }],
      metadata: { device: "watch" },
    });
    await repository.upsertHealthSleepEpisode(sleepEpisode);
    expect(
      await repository.listHealthSleepEpisodes(runtime.agentId, {
        provider: "healthkit",
        startDate: "2026-07-11",
        endDate: "2026-07-11",
      }),
    ).toEqual([expect.objectContaining({ sleepScore: 84 })]);

    const healthSync = createLifeOpsHealthSyncState({
      agentId: runtime.agentId,
      provider: "healthkit",
      grantId: "health-grant",
      cursor: "cursor-1",
      lastSyncedAt: LATER,
      lastSyncStartedAt: NOW,
      lastSyncError: null,
      metadata: { ok: true },
    });
    await repository.upsertHealthSyncState(healthSync);
    expect(
      await repository.getHealthSyncState(
        runtime.agentId,
        "healthkit",
        "health-grant",
      ),
    ).toMatchObject({ cursor: "cursor-1" });

    await repository.upsertCachedInboxMessages(runtime.agentId, [
      {
        id: crypto.randomUUID(),
        channel: "gmail",
        externalId: "gmail-message-1",
        threadId: "thread-1",
        sender: {
          id: "sender@example.com",
          displayName: "Sender",
          email: "sender@example.com",
        },
        subject: "Planning",
        snippet: "Can we meet?",
        receivedAt: NOW,
        unread: true,
        deepLink: "https://mail.example/message",
        sourceRef: { channel: "gmail", externalId: "gmail-message-1" },
        chatType: "dm",
        participantCount: 2,
        gmailAccountId: "gmail-grant",
        gmailAccountEmail: "owner@example.com",
        lastSeenAt: null,
        repliedAt: null,
        priorityScore: 91,
        priorityCategory: "planning",
        priorityFlags: ["needs_reply"],
        connectorAccountId: null,
      },
    ] as never);
    const cachedInbox = await repository.listCachedInboxMessages(
      runtime.agentId,
      {
        channels: ["gmail"],
        gmailAccountId: "gmail-grant",
        maxResults: 5,
      },
    );
    expect(cachedInbox).toHaveLength(1);
    expect(
      await repository.markCachedInboxMessageRead(
        runtime.agentId,
        cachedInbox[0].id,
        LATER,
      ),
    ).toMatchObject({ unread: false, lastSeenAt: LATER });

    await repository.insertTelemetryEvent({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      family: "activity",
      occurredAt: NOW,
      ingestedAt: LATER,
      dedupeKey: "activity:1",
      sourceReliability: 0.9,
      payload: { state: "active" },
    } as never);
    expect(
      await repository.listTelemetryEvents({
        agentId: runtime.agentId,
        familyIn: ["activity"],
        sinceIso: "2026-07-11T00:00:00.000Z",
        untilIso: "2026-07-12T00:00:00.000Z",
        limit: 5,
      }),
    ).toEqual([expect.objectContaining({ dedupeKey: "activity:1" })]);
    expect(
      await repository.upsertTelemetryDailyRollup({
        agentId: runtime.agentId,
        sinceIso: "2026-07-11T00:00:00.000Z",
        untilIso: "2026-07-12T00:00:00.000Z",
      }),
    ).toMatchObject({ bucketsWritten: 1 });

    await repository.upsertScheduleObservation({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      origin: "device",
      deviceId: "macbook",
      deviceKind: "desktop",
      timezone: "UTC",
      observedAt: NOW,
      windowStartAt: NOW,
      windowEndAt: LATER,
      circadianState: "awake",
      stateConfidence: 0.8,
      uncertaintyReason: null,
      mealLabel: "breakfast",
      metadata: { app: "calendar" },
      createdAt: NOW,
      updatedAt: LATER,
    } as never);
    expect(
      await repository.listScheduleObservations(runtime.agentId, NOW, {
        origin: "device",
        deviceId: "macbook",
      }),
    ).toEqual([expect.objectContaining({ mealLabel: "breakfast" })]);

    const scheduledTask = {
      taskId: "task-crud-1",
      agentId: runtime.agentId,
      kind: "reminder",
      promptInstructions: "Remind the owner",
      contextRequest: { roomId: "owner-room" },
      trigger: { kind: "once", atIso: LATER },
      priority: "normal",
      shouldFire: null,
      completionCheck: null,
      escalation: null,
      output: null,
      pipeline: null,
      subject: { kind: "definition", id: definition.id },
      idempotencyKey: "task-crud-1",
      respectsGlobalPause: true,
      state: { status: "scheduled", firedAt: null },
      source: "lifeops",
      createdBy: "agent",
      ownerVisible: true,
      metadata: { source: "test" },
    };
    await repository.upsertScheduledTask(
      runtime.agentId,
      scheduledTask as never,
      { nextFireAtIso: LATER },
    );
    expect(
      await repository.getScheduledTask(runtime.agentId, "task-crud-1"),
    ).toMatchObject({ taskId: "task-crud-1" });
    expect(
      await repository.listScheduledTasks(runtime.agentId, {
        kind: "reminder",
        status: "scheduled",
        subjectKind: "definition",
        subjectId: definition.id,
        source: "lifeops",
        ownerVisibleOnly: true,
        dueAtOrBeforeIso: "2026-07-12T00:00:00.000Z",
        requireNextFireAt: true,
      }),
    ).toHaveLength(1);
    expect(
      await repository.claimScheduledTaskForFire(runtime.agentId, {
        taskId: "task-crud-1",
        firedAtIso: LATER,
      }),
    ).toMatchObject({ kind: "fired" });
    await repository.appendScheduledTaskLog({
      logId: "log-task-crud-1",
      agentId: runtime.agentId,
      taskId: "task-crud-1",
      occurredAtIso: NOW,
      transition: "scheduled_to_fired",
      reason: "test",
      rolledUp: false,
      detail: { firedAt: LATER },
    });
    expect(
      await repository.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: "task-crud-1",
        excludeRollups: true,
      }),
    ).toHaveLength(1);
  });

  it("round-trips connector sync, schedule, and work-thread records", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);

    const calendarEvent = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      provider: "google",
      side: "owner",
      calendarId: "primary",
      externalId: "calendar-event-1",
      title: "Planning review",
      description: "Review the week",
      location: "Home office",
      status: "confirmed",
      startAt: NOW,
      endAt: LATER,
      isAllDay: false,
      timezone: "UTC",
      htmlLink: "https://calendar.example/event",
      conferenceLink: null,
      organizer: { email: "owner@example.com" },
      attendees: [
        { email: "teammate@example.com", responseStatus: "accepted" },
      ],
      accountEmail: "owner@example.com",
      connectorAccountId: null,
      grantId: "calendar-grant",
      metadata: { source: "repository-domain-crud" },
      syncedAt: LATER,
      updatedAt: LATER,
    };
    await repository.upsertCalendarEvent(calendarEvent as never);
    expect(
      await repository.listCalendarEvents(
        runtime.agentId,
        "google",
        "2026-07-11T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
        "owner",
      ),
    ).toEqual([expect.objectContaining({ title: "Planning review" })]);
    expect(
      await repository.listCalendarEventsEndedAfterCursor({
        agentId: runtime.agentId,
        provider: "google",
        side: "owner",
        cursorEndAt: null,
        cursorEventId: null,
        upToIso: "2026-07-12T00:00:00.000Z",
        limit: 5,
      }),
    ).toHaveLength(1);
    const calendarSync = createLifeOpsCalendarSyncState({
      agentId: runtime.agentId,
      provider: "google",
      side: "owner",
      calendarId: "primary",
      windowStartAt: NOW,
      windowEndAt: LATER,
      syncedAt: LATER,
    });
    await repository.upsertCalendarSyncState(calendarSync);
    expect(
      await repository.getCalendarSyncState(
        runtime.agentId,
        "google",
        "primary",
        "owner",
      ),
    ).toMatchObject({ calendarId: "primary" });

    const gmailMessage = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      provider: "gmail",
      side: "owner",
      externalId: "gmail-external-1",
      connectorAccountId: null,
      grantId: "gmail-grant",
      accountEmail: "owner@example.com",
      threadId: "gmail-thread-1",
      subject: "Status",
      from: "Sender",
      fromEmail: "sender@example.com",
      replyTo: null,
      to: ["owner@example.com"],
      cc: [],
      snippet: "Can you review?",
      receivedAt: NOW,
      isUnread: true,
      isImportant: true,
      likelyReplyNeeded: true,
      triageScore: 88,
      triageReason: "direct ask",
      labels: ["INBOX"],
      htmlLink: "https://mail.example/message",
      metadata: { label: "coverage" },
      syncedAt: LATER,
      updatedAt: LATER,
    };
    await repository.upsertGmailMessage(gmailMessage as never);
    expect(
      await repository.listGmailMessages(
        runtime.agentId,
        "gmail",
        { threadId: "gmail-thread-1", grantId: "gmail-grant", maxResults: 5 },
        "owner",
      ),
    ).toEqual([expect.objectContaining({ subject: "Status" })]);
    expect(
      await repository.getGmailMessage(
        runtime.agentId,
        "gmail",
        gmailMessage.id,
        "owner",
        "gmail-grant",
      ),
    ).toMatchObject({ likelyReplyNeeded: true });
    const gmailSync = createLifeOpsGmailSyncState({
      agentId: runtime.agentId,
      provider: "gmail",
      side: "owner",
      mailbox: "INBOX",
      grantId: "gmail-grant",
      maxResults: 25,
      syncedAt: LATER,
    });
    await repository.upsertGmailSyncState(gmailSync);
    expect(
      await repository.getGmailSyncState(
        runtime.agentId,
        "gmail",
        "INBOX",
        "owner",
        "gmail-grant",
      ),
    ).toMatchObject({ maxResults: 25 });

    const spamReviewItem = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      provider: "gmail",
      side: "owner",
      grantId: "gmail-grant",
      accountEmail: "owner@example.com",
      messageId: gmailMessage.id,
      externalMessageId: "gmail-external-1",
      threadId: "gmail-thread-1",
      subject: "Status",
      from: "Sender",
      fromEmail: "sender@example.com",
      receivedAt: NOW,
      snippet: "Can you review?",
      labels: ["SPAM"],
      rationale: "owner requested review",
      confidence: 0.72,
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
      reviewedAt: null,
    };
    await repository.upsertGmailSpamReviewItem(spamReviewItem as never);
    await repository.updateGmailSpamReviewItemStatus(
      runtime.agentId,
      "gmail",
      spamReviewItem.id,
      "approved" as never,
      LATER,
      LATER,
      "owner",
    );
    expect(
      await repository.getGmailSpamReviewItem(
        runtime.agentId,
        "gmail",
        spamReviewItem.id,
        "owner",
      ),
    ).toMatchObject({ status: "approved" });

    const commitment = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      source: "chat",
      sourceKey: "chat-commitment-1",
      kind: "commitment",
      summary: "Send the planning note",
      counterparty: "teammate@example.com",
      dueAt: LATER,
      confidence: 0.9,
      status: "open",
      scheduledTaskId: null,
      metadata: { origin: "chat" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repository.upsertCommitmentLedgerRecord(commitment as never);
    expect(
      await repository.listCommitmentLedgerRecords(runtime.agentId, {
        statuses: ["open"],
        dueBeforeIso: "2026-07-12T00:00:00.000Z",
        source: "chat",
      }),
    ).toEqual([expect.objectContaining({ summary: "Send the planning note" })]);
    expect(
      await repository.getCommitmentLedgerRecord(
        runtime.agentId,
        commitment.id,
      ),
    ).toMatchObject({ status: "open" });

    const delegationContract = {
      contractId: "delegation-1",
      agentId: runtime.agentId,
      status: "active",
      objective: "Answer scheduling messages",
      scope: {
        channels: ["email"],
        counterparties: ["teammate@example.com"],
        topics: ["scheduling"],
      },
      autonomyLevel: "draft_only",
      tripwires: [{ kind: "money_amount", threshold: 100 }],
      ownerUserId: runtime.agentId,
      requestedBy: "owner",
      state: { handledTurnCount: 1 },
      sla: { holdingReplyAfterMinutes: 30, escalateAfterMinutes: 120 },
      metadata: { source: "repository-domain-crud" },
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: "2026-07-18T00:00:00.000Z",
    };
    await repository.upsertDelegationContract(delegationContract as never);
    expect(
      await repository.listDelegationContracts(runtime.agentId, {
        statuses: ["active"],
        activeAtIso: NOW,
      }),
    ).toEqual([
      expect.objectContaining({ objective: "Answer scheduling messages" }),
    ]);
    expect(
      await repository.getDelegationContract(runtime.agentId, "delegation-1"),
    ).toMatchObject({ status: "active" });

    const screenTimeSession = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      source: "browser",
      identifier: "example.com",
      displayName: "Example",
      startAt: NOW,
      endAt: null,
      durationSeconds: 0,
      isActive: true,
      metadata: { tab: "research" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repository.upsertScreenTimeSession(screenTimeSession as never);
    await repository.finishScreenTimeSession(
      runtime.agentId,
      screenTimeSession.id,
      LATER,
      3600,
    );
    expect(
      await repository.getScreenTimeSession(
        runtime.agentId,
        screenTimeSession.id,
      ),
    ).toMatchObject({ isActive: false, durationSeconds: 3600 });
    expect(
      await repository.listScreenTimeSessionsBetween(
        runtime.agentId,
        "2026-07-11T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
        { source: "browser", limit: 5 },
      ),
    ).toHaveLength(1);
    expect(
      await repository.listScreenTimeSessionsOverlapping(
        runtime.agentId,
        "2026-07-11T08:30:00.000Z",
        "2026-07-11T08:45:00.000Z",
      ),
    ).toHaveLength(1);
    await repository.upsertScreenTimeDaily({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      source: "browser",
      identifier: "example.com",
      date: "2026-07-11",
      totalSeconds: 3600,
      sessionCount: 1,
      metadata: { rollup: true },
      createdAt: NOW,
      updatedAt: LATER,
    } as never);
    expect(
      await repository.listScreenTimeDaily(runtime.agentId, "2026-07-11", {
        source: "browser",
        limit: 5,
      }),
    ).toEqual([expect.objectContaining({ totalSeconds: 3600 })]);

    await repository.upsertCircadianState({
      agentId: runtime.agentId,
      circadianState: "awake",
      stateConfidence: 0.91,
      uncertaintyReason: null,
      enteredAt: NOW,
      sinceSleepDetectedAt: null,
      sinceWakeObservedAt: NOW,
      sinceWakeConfirmedAt: LATER,
      evidenceRefs: ["screen:example.com"],
      createdAt: NOW,
      updatedAt: LATER,
    });
    expect(await repository.readCircadianState(runtime.agentId)).toMatchObject({
      circadianState: "awake",
    });
    await repository.upsertSleepEpisode({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      startAt: "2026-07-10T23:00:00.000Z",
      endAt: "2026-07-11T07:00:00.000Z",
      source: "health",
      confidence: 0.84,
      cycleType: "night_sleep",
      sealed: true,
      evidence: [{ kind: "health_sleep", ref: "sleep-1" }],
      createdAt: NOW,
      updatedAt: LATER,
    } as never);
    expect(
      await repository.listSleepEpisodesBetween(
        runtime.agentId,
        "2026-07-10T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
      ),
    ).toEqual([expect.objectContaining({ sealed: true })]);

    await repository.upsertScheduleMergedState({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      scope: "owner_day",
      mergedAt: LATER,
      effectiveDayKey: "2026-07-11",
      localDate: "2026-07-11",
      timezone: "UTC",
      inferredAt: LATER,
      circadianState: "awake",
      stateConfidence: 0.83,
      uncertaintyReason: null,
      awakeProbability: {
        probability: 0.88,
        computedAt: LATER,
        contributors: [
          { source: "screen", weight: 0.7, value: 1, description: "active" },
        ],
      },
      regularity: {
        confidence: 0.5,
        wakeStddevMinutes: 20,
        bedtimeStddevMinutes: 30,
        sampleDays: 7,
      },
      baseline: {
        medianWakeLocalHour: 7,
        medianBedtimeLocalHour: 23,
        medianSleepDurationMin: 480,
        bedtimeStddevMin: 30,
        wakeStddevMin: 20,
        sampleCount: 7,
        windowDays: 14,
      },
      circadianRuleFirings: [],
      sleepStatus: "awake",
      sleepConfidence: 0.78,
      currentSleepStartedAt: null,
      lastSleepStartedAt: "2026-07-10T23:00:00.000Z",
      lastSleepEndedAt: "2026-07-11T07:00:00.000Z",
      lastSleepDurationMinutes: 480,
      wakeAt: "2026-07-11T07:00:00.000Z",
      firstActiveAt: NOW,
      lastActiveAt: LATER,
      meals: [{ label: "breakfast", at: NOW, confidence: 0.6 }],
      lastMealAt: NOW,
      nextMealLabel: "lunch",
      nextMealWindowStartAt: "2026-07-11T12:00:00.000Z",
      nextMealWindowEndAt: "2026-07-11T13:00:00.000Z",
      nextMealConfidence: 0.7,
      observationCount: 3,
      deviceCount: 1,
      contributingDeviceKinds: ["desktop"],
      metadata: { merged: true },
      createdAt: NOW,
      updatedAt: LATER,
    } as never);
    expect(
      await repository.getScheduleMergedState(
        runtime.agentId,
        "owner_day" as never,
        "UTC",
      ),
    ).toMatchObject({ circadianState: "awake" });

    const negotiation = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      subject: "Planning review",
      relationshipId: "teammate",
      durationMinutes: 30,
      timezone: "UTC",
      state: "initiated",
      acceptedProposalId: null,
      startedAt: NOW,
      finalizedAt: null,
      metadata: { source: "repository-domain-crud" },
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repository.upsertSchedulingNegotiation(negotiation as never);
    await repository.updateSchedulingNegotiationState(
      runtime.agentId,
      negotiation.id,
      "proposed",
      null,
    );
    expect(
      await repository.listSchedulingNegotiations(runtime.agentId, {
        state: "proposed",
        limit: 5,
      }),
    ).toEqual([expect.objectContaining({ subject: "Planning review" })]);
    const proposal = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      negotiationId: negotiation.id,
      startAt: NOW,
      endAt: LATER,
      proposedBy: "agent",
      status: "pending",
      metadata: { rank: 1 },
      createdAt: NOW,
      updatedAt: NOW,
    };
    await repository.upsertSchedulingProposal(proposal as never);
    await repository.updateSchedulingProposalStatus(
      runtime.agentId,
      proposal.id,
      "accepted",
    );
    expect(
      await repository.getSchedulingProposal(runtime.agentId, proposal.id),
    ).toMatchObject({ status: "accepted" });
    expect(
      await repository.listSchedulingProposals(runtime.agentId, negotiation.id),
    ).toHaveLength(1);

    await repository.upsertXDm({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      externalDmId: "xdm-1",
      conversationId: "x-conversation-1",
      senderHandle: "sender",
      senderId: "sender-id",
      isInbound: true,
      text: "Can we talk?",
      receivedAt: NOW,
      readAt: null,
      repliedAt: null,
      metadata: { source: "x" },
      syncedAt: NOW,
      updatedAt: LATER,
    } as never);
    expect(
      await repository.listXDms(runtime.agentId, {
        conversationId: "x-conversation-1",
        limit: 5,
      }),
    ).toHaveLength(1);
    await repository.upsertXFeedItem({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      externalTweetId: "tweet-1",
      authorHandle: "author",
      authorId: "author-id",
      text: "Signal",
      createdAtSource: NOW,
      feedType: "home",
      metadata: { source: "x" },
      syncedAt: NOW,
      updatedAt: LATER,
    } as never);
    expect(
      await repository.listXFeedItems(runtime.agentId, "home" as never, {
        limit: 5,
      }),
    ).toHaveLength(1);
    await repository.upsertXSyncState({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      feedType: "home",
      lastCursor: "cursor-x",
      syncedAt: NOW,
      updatedAt: LATER,
    } as never);
    expect(
      await repository.getXSyncState(runtime.agentId, "home" as never),
    ).toMatchObject({ lastCursor: "cursor-x" });

    const workThread = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      ownerEntityId: runtime.agentId,
      status: "active",
      title: "Planning thread",
      summary: "Schedule planning review",
      currentPlanSummary: "Find a time",
      primarySourceRef: {
        connector: "chat",
        roomId: "owner-room",
        canRead: true,
        canMutate: true,
      },
      sourceRefs: [
        {
          connector: "email",
          externalThreadId: "gmail-thread-1",
          canRead: true,
          canMutate: false,
        },
      ],
      participantEntityIds: ["teammate"],
      currentScheduledTaskId: null,
      workflowRunId: null,
      approvalId: null,
      lastMessageMemoryId: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      lastActivityAt: LATER,
      metadata: { source: "repository-domain-crud" },
    };
    await repository.upsertWorkThread(runtime.agentId, workThread as never);
    expect(
      await repository.getWorkThread(runtime.agentId, workThread.id),
    ).toMatchObject({ title: "Planning thread" });
    expect(
      await repository.listWorkThreads(runtime.agentId, {
        statuses: ["active"],
        roomId: "owner-room",
        includeCrossChannel: true,
        limit: 5,
      }),
    ).toHaveLength(1);
    await repository.appendWorkThreadEvent({
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      workThreadId: workThread.id,
      occurredAt: LATER,
      type: "created",
      reason: "coverage",
      detail: { source: "repository-domain-crud" },
    });
    expect(
      await repository.listWorkThreadEvents({
        agentId: runtime.agentId,
        workThreadId: workThread.id,
        limit: 5,
      }),
    ).toHaveLength(1);
  });
});
