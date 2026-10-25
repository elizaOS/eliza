/** Loopback request metadata reaches the actual Notes read without changing persisted records. */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  type ActionResult,
  ChannelType,
  executePlannedToolCall,
  type IAgentRuntime,
  type UUID,
} from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { notesPlugin } from "../../../plugins/plugin-notes/src/plugin.ts";
import {
  NOTES_SERVICE_TYPE,
  NotesService,
} from "../../../plugins/plugin-notes/src/service.ts";
import { NotesStore } from "../../../plugins/plugin-notes/src/store.ts";
import { buildUserMessages } from "../src/api/server-helpers.ts";

it.each(
  [
    {
      name: "uses UI timezone",
      explicit: undefined,
      expected: {
        label: expect.stringMatching(/^Sep 25, 2026(?:,| at) 5:06:15 PM PDT$/),
        timeZone: "America/Los_Angeles",
        source: "ui",
      },
    },
    {
      name: "explicit timezone wins",
      explicit: "Asia/Tokyo",
      expected: {
        label: expect.stringMatching(
          /^Sep 26, 2026(?:,| at) 9:06:15 AM GMT\+9$/,
        ),
        timeZone: "Asia/Tokyo",
        source: "explicit",
      },
    },
    {
      name: "invalid explicit timezone never falls back",
      explicit: "invalid/zone",
      expected: undefined,
    },
  ].flatMap((scenario) =>
    ["NOTES_LIST", "NOTES_GET"].map((action) => ({ ...scenario, action })),
  ),
)(
  "Notes display delivery: $action $name",
  async ({ action, explicit, expected }) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "notes-display-delivery-"),
    );
    const owner = randomUUID() as UUID;
    const room = randomUUID() as UUID;
    const useModel = vi.fn(async () => {
      throw new Error("This read must not invoke a model");
    });
    const runtime = {
      agentId: randomUUID() as UUID,
      actions: notesPlugin.actions,
      getService: (type: string) =>
        type === NOTES_SERVICE_TYPE ? service : null,
      getServiceLoadPromise: async () => null,
      getRoom: async () => ({ worldId: "world" }),
      getWorld: async () => ({
        metadata: {
          roles: { [owner]: "OWNER" },
          roleSources: { [owner]: "manual" },
        },
      }),
      reportError: vi.fn(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      useModel,
    } as unknown as IAgentRuntime;
    const service = new NotesService(runtime, {
      store: new NotesStore({ filePath: path.join(directory, "notes.json") }),
      now: () => new Date("2026-09-26T00:06:15.137Z"),
    });
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const { userMessage } = await buildUserMessages({
          images: undefined,
          prompt: body.text,
          userId: owner,
          agentId: runtime.agentId,
          roomId: room,
          channelType: ChannelType.DM,
          metadata: body.metadata,
        });
        const result = await executePlannedToolCall(
          runtime,
          {
            message: userMessage,
            activeContexts: ["notes"],
            userRoles: ["OWNER"],
          },
          { name: action, params: body.parameters },
        );
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(result));
      } catch (error) {
        response.statusCode = 500;
        response.end(String(error));
      }
    });
    try {
      await service.initialize();
      const note = await service.createNote({
        title: '"today" is a title',
        body: "Preserve  AM/PM and whitespace.",
      });
      if (action === "NOTES_GET")
        await service.createNote({
          title: "Decoy",
          body: "Do not return this record.",
        });
      const snapshot = service.snapshot();
      const persisted = await fs.readFile(service.store.filePath, "utf8");
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Read my most recently updated note.",
          metadata: { uiTimeZone: "America/Los_Angeles" },
          parameters: {
            ...(action === "NOTES_GET"
              ? { noteId: note.id }
              : { latestBy: "updatedAt" }),
            ...(explicit === undefined ? {} : { displayTimeZone: explicit }),
          },
        }),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as ActionResult;
      if (expected) {
        expect(result).toMatchObject({
          success: true,
          data: {
            ...(action === "NOTES_GET"
              ? {
                  noteTimestampDisplay: {
                    noteId: note.id,
                    timeZone: expected.timeZone,
                    source: expected.source,
                    createdAt: expected.label,
                    updatedAt: expected.label,
                  },
                }
              : {
                  selection: {
                    field: "updatedAt",
                    at: note.updatedAt,
                    display: expected,
                  },
                }),
            notes: [{ ...note, sourceNote: service.sourceReference(note) }],
            notesRevision: snapshot.revision,
          },
        });
        expect(result.data?.notes).toEqual([
          { ...note, sourceNote: service.sourceReference(note) },
        ]);
        if (action === "NOTES_GET")
          expect(result.data).toMatchObject({
            count: 1,
            total: 2,
            requestedNoteId: note.id,
          });
      } else {
        expect(result).toMatchObject({
          success: false,
          data: { error: "NOTES_INVALID_DISPLAY_TIME_ZONE" },
        });
        expect(result.data).not.toHaveProperty("selection");
        expect(result.data).not.toHaveProperty("notes");
      }
      expect(useModel).not.toHaveBeenCalled();
      expect(service.snapshot()).toEqual(snapshot);
      expect(await fs.readFile(service.store.filePath, "utf8")).toBe(persisted);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await service.stop();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
