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
