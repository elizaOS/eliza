import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { expect, test } from "vitest";
import { deviceRequestCredential } from "../../../packages/agent/src/api/device-action-routes";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { queryLocalNotes } from "../../plugin-notes/src/client/notes-query";
import { NotesStore } from "../../plugin-notes/src/client/notes-store";
import {
  deviceActionForCapabilities,
  proposeDeviceAction,
} from "../src/services/device-actions/action";
import { deviceActionEffectReceipts } from "../src/services/device-actions/effect-receipts.ts";
import { validateNotesQueryResult } from "../src/services/device-actions/notes-query-result";
import {
  DeviceActionService,
  deviceProposalDigest,
} from "../src/services/device-actions/service";

test("negotiated Notes discovery keeps real approval/enrollment/receipt scope and successful empty reads", async () => {
  const fixture = await createRealTestRuntime({
      characterName: "NativeNotesQueryScope",
    }),
    runtime = fixture.runtime;
  const service = new DeviceActionService(runtime),
    base = {
      subjectUserId: "fixture-owner",
      installationId: randomUUID(),
      deviceKey: "a".repeat(64),
      capabilities: ["notes.local-record.v1"],
    },
    credential = {
      ...base,
      capabilities: [...base.capabilities, "notes.query.v1"],
    };
  try {
    await service.register(base, "Notes query");
    const operation = {
      type: "notes_query" as const,
      query: { kind: "title" as const, text: "Selected" },
    };
    const types = (caps?: string[]) =>
      deviceActionForCapabilities(proposeDeviceAction, caps)
        .parameters!.find((p) => p.name === "operation")!
        .schema.anyOf!.flatMap((branch) => branch.properties?.type?.enum ?? []);
    expect(types()).not.toContain("notes_query");
    expect(types(base.capabilities)).not.toContain("notes_query");
    expect(types(["notes.query.v1"])).not.toContain("notes_query");
    expect(types(credential.capabilities)).toContain("notes_query");
    await expect(
      service.propose(base, operation, "old-client", "Read requested note"),
    ).rejects.toThrow("capability");
    const pending = await service.propose(
      credential,
      operation,
      "title-query",
      "Read requested note",
    );
    expect(JSON.stringify(pending)).not.toContain("UNSELECTED_PRIVATE_BODY");
    expect(await service.list(base)).toEqual([]);
    const digest = deviceProposalDigest(pending);
    await expect(
      service.decide(
        { ...credential, subjectUserId: "other-owner" },
        pending.id,
        digest,
        "approve",
      ),
    ).rejects.toThrow();
    await service.decide(credential, pending.id, digest, "approve");
    const claimed = await service.claim(credential, pending.id, digest);
    const values = new Map<string, string>(),
      store = new NotesStore(
        { current: "notes", legacy: "legacy" },
        {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => {
            values.set(key, value);
          },
        },
        [
          {
            id: "selected",
            kind: "text",
            title: "Selected",
            body: "Confirmed exact text",
            createdAt: 200,
          },
          {
            id: "other",
            kind: "text",
            title: "Other",
            body: "UNSELECTED_PRIVATE_BODY",
            createdAt: 100,
          },
        ],
      );
    const selected = queryLocalNotes(store.list, operation.query).candidates[0],
      target = await store.target(selected.id),
      record = await store.execute(
        { type: "notes_read_selected", target },
        "read",
        new AbortController().signal,
        () => {},
      );
    const result = validateNotesQueryResult(operation, {
      version: 1,
      kind: "notes_query",
      query: operation.query,
      basis: "title-match",
      target,
      record,
    });
    expect(JSON.stringify(result)).not.toContain("UNSELECTED_PRIVATE_BODY");
    const done = await service.receipt(
      credential,
      pending.id,
      digest,
      claimed.execution!.attemptId,
      { outcome: "applied", operationId: "read", result },
    );
    expect(done.state).toBe("done");
    expect(() =>
      validateNotesQueryResult(operation, {
        ...result,
        query: { kind: "title", text: "Other" },
      }),
    ).toThrow();
    expect(() =>
      validateNotesQueryResult(operation, {
        ...result,
        target: { ...target, noteId: "other" },
      }),
    ).toThrow();
    for (const query of [
      { kind: "title" as const, text: "Missing" },
      { kind: "latest" as const, by: "created" as const },
    ]) {
      const rows = query.kind === "title" ? store.list : [];
      expect(queryLocalNotes(rows, query).candidates).toHaveLength(0);
      const op = { type: "notes_query" as const, query };
      const empty = validateNotesQueryResult(op, {
        version: 1,
        kind: "notes_query",
        query,
        basis: "no-match",
      });
      expect(empty).not.toHaveProperty("target");
      expect(empty).not.toHaveProperty("record");
      const proposal = await service.propose(
          credential,
          op,
          randomUUID(),
          "Read request",
        ),
        hash = deviceProposalDigest(proposal);
      await service.decide(credential, proposal.id, hash, "approve");
      const claim = await service.claim(credential, proposal.id, hash);
      expect(
        (
          await service.receipt(
            credential,
            proposal.id,
            hash,
            claim.execution!.attemptId,
            { outcome: "applied", operationId: randomUUID(), result: empty },
          )
        ).state,
      ).toBe("done");
    }
    const headers = {
      "x-eliza-device-id": credential.installationId,
      "x-eliza-device-key": credential.deviceKey,
      "x-eliza-device-capabilities":
        "calendar.local-event.v1,notes.local-record.v1,notes.query.v1,reminders.local-record.v2,reminders.create.v1,maps.selected-read.v1,clock.handoff.v1",
    };
    const authorization = {
      ok: true,
      role: "OWNER",
      identityId: "fixture-owner",
      principal: "fixture-owner",
    } as any;
    expect(
      deviceRequestCredential({ headers } as IncomingMessage, authorization)
        ?.capabilities,
    ).toContain("notes.query.v1");
    expect(
      deviceRequestCredential(
        {
          headers: {
            ...headers,
            "x-eliza-device-capabilities":
              headers["x-eliza-device-capabilities"] + ",notes.query.v1",
          },
        } as IncomingMessage,
        authorization,
      ),
    ).toBeNull();
    expect(
      deviceRequestCredential(
        {
          headers: {
            ...headers,
            "x-eliza-device-capabilities":
              headers["x-eliza-device-capabilities"] +
              ",reminders.local-record.v1",
          },
        } as IncomingMessage,
        authorization,
      ),
    ).toBeNull();
  } finally {
    await fixture.cleanup();
  }
});

// Shared review protocols use the same persisted approval and receipt boundary.
test("foreground search, availability and named edits preserve negotiated owner review", async () => {
  const { calendarAvailability } = await import("@elizaos/contracts");
  const { validateDeviceOperation } = await import(
    "../src/services/device-actions/contract.ts"
  );
  const fixture = await createRealTestRuntime({
    characterName: "ForegroundReviewScope",
  });
  const service = new DeviceActionService(fixture.runtime);
  const credential = {
    subjectUserId: "review-owner",
    installationId: randomUUID(),
    deviceKey: "c".repeat(64),
    capabilities: [
      "notes.local-record.v1",
      "notes.search.v1",
      "calendar.local-event.v1",
      "calendar.availability-read.v1",
      "device.named-target.v1",
      "reminders.local-record.v2",
    ],
  };
  const values = new Map<string, string>();
  const store = new NotesStore(
    { current: "review-notes", legacy: "legacy" },
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
    [
      {
        id: "chosen",
        kind: "text",
        title: "Travel",
        body: "Passport renewal",
        createdAt: 200,
      },
      {
        id: "private",
        kind: "text",
        title: "Other",
        body: "UNSELECTED_PRIVATE_BODY",
        createdAt: 100,
      },
    ],
  );
  try {
    await service.register(credential, "Foreground reviews");
    const parsed = deviceRequestCredential(
      {
        headers: {
          "x-eliza-device-id": credential.installationId,
          "x-eliza-device-key": credential.deviceKey,
          "x-eliza-device-capabilities": credential.capabilities.join(","),
        },
      } as IncomingMessage,
      {
        ok: true,
        role: "OWNER",
        identityId: credential.subjectUserId,
        principal: credential.subjectUserId,
      } as any,
    );
    expect(parsed?.capabilities).toEqual(credential.capabilities);
    const exposed = (caps?: string[]) =>
      deviceActionForCapabilities(proposeDeviceAction, caps)
        .parameters!.find((p) => p.name === "operation")!
        .schema.anyOf!.flatMap((branch) => branch.properties?.type?.enum ?? []);
    for (const type of [
      "notes_search",
      "calendar_availability",
      "notes_named",
      "calendar_named",
      "reminder_named",
    ]) {
      expect(exposed()).not.toContain(type);
      expect(exposed(credential.capabilities)).toContain(type);
    }
    const selected = await store.target("chosen");
    const noteRecord = await store.execute(
      { type: "notes_read_selected", target: selected },
      "selected-read",
      new AbortController().signal,
      () => {},
    );
    const availability = {
      type: "calendar_availability" as const,
      start: "2026-09-06T03:00:00.000Z",
      end: "2026-09-06T05:00:00.000Z",
      timeZone: "America/Santiago",
    };
    // Chile skips midnight on this civil date. No part of the prior date is busy.
    const busy = calendarAvailability(availability, 1, [
      {
        start: "2026-09-06T00:00:00.000Z",
        end: "2026-09-07T00:00:00.000Z",
        allDay: true,
        availability: "busy",
      },
    ]);
    expect(busy.busy[0]?.start).toBe("2026-09-06T04:00:00.000Z");
    const cases = [
      {
        operation: availability,
        result: busy,
        invalid: {
          ...busy,
          window: { ...busy.window, end: "2026-09-06T06:00:00.000Z" },
        },
      },
      {
        operation: {
          type: "notes_search",
          query: { kind: "content", text: "Passport" },
        },
        result: {
          version: 1,
          kind: "notes_search",
          query: { kind: "content", text: "Passport" },
          basis: "content-match",
          target: selected,
          record: noteRecord,
        },
        invalid: {
          version: 1,
          kind: "notes_search",
          query: { kind: "content", text: "Passport" },
          basis: "content-match",
          target: { ...selected, noteId: "private" },
          record: noteRecord,
        },
      },
      {
        operation: {
          type: "notes_search",
          query: { kind: "titles", limit: 1 },
        },
        result: {
          version: 1,
          kind: "notes_search",
          query: { kind: "titles", limit: 1 },
          basis: "titles-reviewed",
          titles: ["Travel"],
          truncated: true,
        },
        invalid: {
          version: 1,
          kind: "notes_search",
          query: { kind: "titles", limit: 1 },
          basis: "titles-reviewed",
          titles: ["Travel", "Other"],
          truncated: false,
        },
      },
      ...["calendar_named", "reminder_named"].map((type) => ({
        operation: {
          type,
          action: type === "reminder_named" ? "cancel" : "delete",
          name: "Missing",
        },
        result: {
          version: 1,
          kind: type,
          action: type === "reminder_named" ? "cancel" : "delete",
          name: "Missing",
          basis: "no-match",
        },
        invalid: {
          version: 1,
          kind: type,
          action: "update",
          name: "Missing",
          basis: "no-match",
        },
      })),
    ];
    for (const scenario of cases) {
      const operation = validateDeviceOperation(scenario.operation);
      await expect(
        service.propose(
          { ...credential, capabilities: [] },
          operation,
          randomUUID(),
          "Review",
        ),
      ).rejects.toThrow(/capability/);
      const proposal = await service.propose(
        credential,
        operation,
        randomUUID(),
        "Review",
      );
      const digest = deviceProposalDigest(proposal);
      expect(await service.list({ ...credential, capabilities: [] })).toEqual(
        [],
      );
      await expect(
        service.decide(
          { ...credential, subjectUserId: "other-owner" },
          proposal.id,
          digest,
          true,
        ),
      ).rejects.toThrow();
      await service.decide(credential, proposal.id, digest, true);
      const claim = await service.claim(credential, proposal.id, digest);
      const receipt = (result: unknown) =>
        service.receipt(
          credential,
          proposal.id,
          digest,
          claim.execution!.attemptId,
          { outcome: "applied", operationId: randomUUID(), result },
        );
      await expect(receipt(scenario.invalid)).rejects.toThrow(
        /foreground review/,
      );
      const done = await receipt(scenario.result);
      expect(done.state).toBe("done");
      expect(
        deviceActionEffectReceipts({ request: done, reused: true })[0]?.outcome,
      ).toBe("noop");
      expect(JSON.stringify(done)).not.toContain("UNSELECTED_PRIVATE_BODY");
    }
    // A named edit cannot substitute different fields after the owner approves it.
    const operation = validateDeviceOperation({
      type: "notes_named",
      action: "update",
      name: "Travel",
      fields: { title: "Travel", body: "Reviewed replacement" },
    });
    const proposal = await service.propose(
      credential,
      operation,
      randomUUID(),
      "Update selected note",
    );
    const digest = deviceProposalDigest(proposal);
    await service.decide(credential, proposal.id, digest, true);
    const claim = await service.claim(credential, proposal.id, digest);
    const exact = {
      type: "notes_update" as const,
      target: selected,
      fields: { title: "Travel", body: "Reviewed replacement" },
    };
    const record = await store.execute(
      exact,
      "named-update",
      new AbortController().signal,
      () => {},
    );
    const result = {
      version: 1,
      kind: "notes_named",
      action: "update",
      name: "Travel",
      basis: "owner-chosen",
      operation: exact,
      record,
    };
    await expect(
      service.receipt(
        credential,
        proposal.id,
        digest,
        claim.execution!.attemptId,
        {
          outcome: "applied",
          operationId: "named-update",
          result: {
            ...result,
            operation: {
              ...exact,
              fields: { ...exact.fields, body: "Unapproved replacement" },
            },
          },
        },
      ),
    ).rejects.toThrow(/foreground review/);
    expect(
      (
        await service.receipt(
          credential,
          proposal.id,
          digest,
          claim.execution!.attemptId,
          { outcome: "applied", operationId: "named-update", result },
        )
      ).state,
    ).toBe("done");
    expect(store.list.find((note) => note.id === "chosen")?.body).toBe(
      "Reviewed replacement",
    );
    expect(store.list.find((note) => note.id === "private")?.body).toBe(
      "UNSELECTED_PRIVATE_BODY",
    );
    const v1 = {
      ...credential,
      capabilities: ["device.named-target.v1", "reminders.local-record.v1"],
    };
    const timed = validateDeviceOperation({
      type: "reminder_named",
      action: "update",
      name: "Pills",
      fields: {
        title: "Pills",
        body: "",
        schedule: {
          at: 1792000000000,
          dueAt: 1792000000000,
          alertMinutes: null,
          recurrence: null,
        },
      },
    });
    await expect(
      service.propose(v1, timed, randomUUID(), "No-alert reminder"),
    ).rejects.toThrow(/capability/);
    const timedProposal = await service.propose(
      credential,
      timed,
      randomUUID(),
      "No-alert reminder",
    );
    await expect(
      service.decide(
        v1,
        timedProposal.id,
        deviceProposalDigest(timedProposal),
        true,
      ),
    ).rejects.toThrow(/capability/);
    const cancel = validateDeviceOperation({
      type: "reminder_named",
      action: "cancel",
      name: "Pills",
    });
    const cancelProposal = await service.propose(
      v1,
      cancel,
      randomUUID(),
      "Cancel reminder",
    );
    const cancelDigest = deviceProposalDigest(cancelProposal);
    await service.decide(v1, cancelProposal.id, cancelDigest, true);
    const cancelClaim = await service.claim(
      v1,
      cancelProposal.id,
      cancelDigest,
    );
    const target = {
      sourceId: "reminders",
      sourceRevision: "a".repeat(64),
      reminderId: "pills",
      occurrenceId: "occurrence",
      revision: "b".repeat(64),
    };
    const cancelled = {
      version: 1,
      kind: "reminder_cancel",
      sourceId: "reminders",
      reminderId: "pills",
      occurrenceId: "occurrence",
      revision: "c".repeat(64),
      status: "cancelled",
      at: 1792000000000,
    };
    const cancellation = {
      version: 1,
      kind: "reminder_named",
      action: "cancel",
      name: "Pills",
      basis: "owner-chosen",
      operation: { type: "reminder_cancel", target },
      record: cancelled,
    };
    await expect(
      service.receipt(
        v1,
        cancelProposal.id,
        cancelDigest,
        cancelClaim.execution!.attemptId,
        {
          outcome: "applied",
          operationId: "cancel",
          result: {
            ...cancellation,
            operation: {
              type: "reminder_cancel",
              target: { ...target, timingVersion: 2 },
            },
            record: { ...cancelled, dueAt: cancelled.at, alertMinutes: null },
          },
        },
      ),
    ).rejects.toThrow(/foreground review/);
    const completed = await service.receipt(
      v1,
      cancelProposal.id,
      cancelDigest,
      cancelClaim.execution!.attemptId,
      { outcome: "applied", operationId: "cancel", result: cancellation },
    );
    expect(
      deviceActionEffectReceipts({ request: completed, reused: true })[0]
        ?.outcome,
    ).toBe("applied");
  } finally {
    await fixture.cleanup();
  }
});

test("foreground review discriminators reject values that stringify to valid actions", async () => {
  const { calendarAvailability, validateNamedTargetOperation } = await import(
    "@elizaos/contracts"
  );
  const { namedTargetValidators } = await import(
    "../src/services/device-actions/foreground-review-contract.ts"
  );
  for (const type of ["notes_named", "calendar_named", "reminder_named"]) {
    for (const action of [
      ["update"],
      ["delete"],
      { toString: () => "update" },
    ]) {
      expect(() =>
        validateNamedTargetOperation(
          { type, action, name: "Selected" },
          namedTargetValidators,
        ),
      ).toThrow();
    }
    expect(() =>
      validateNamedTargetOperation(
        { type: [type], action: "delete", name: "Selected" },
        namedTargetValidators,
      ),
    ).toThrow();
  }
  const operation = {
    type: "calendar_availability" as const,
    start: "2026-10-09T12:00:00.000Z",
    end: "2026-10-09T13:00:00.000Z",
    timeZone: "UTC",
  };
  expect(() =>
    calendarAvailability(operation, 1, [
      {
        start: operation.start,
        end: operation.end,
        allDay: false,
        availability: ["free"] as unknown as "free",
      },
    ]),
  ).toThrow();
});
