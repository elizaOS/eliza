// @vitest-environment node
/**
 * A title named only inside a retrieved document must not surface the note:
 * NAMED_NOTES matches titles the user explicitly names this turn, so the
 * lookup input is the user's own words, not the document-augmentation
 * envelope text that also carries retrieved documents.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { namedNotesProvider } from "./provider.ts";
import { NOTES_SERVICE_TYPE, NotesService } from "./service.ts";
import { NotesStore } from "./store.ts";

const directories: string[] = [];
const runtimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "notes-user-words-"),
  );
  directories.push(directory);
  const service = new NotesService(undefined, {
    store: new NotesStore({ filePath: path.join(directory, "state.json") }),
  });
  await service.initialize();
  await service.createNote({
    content: "Secret project plan\nSECRET-NOTE-BODY exact text.",
  });
  const runtime = new AgentRuntime({
    agentId: stringToUuid(directory),
    character: createCharacter({ name: "User words fixture" }),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  await initializeTestRuntime(runtime, { skipMigrations: true });
  class BoundService extends NotesService {
    static override async start() {
      return service;
    }
  }
  await runtime.registerService(BoundService);
  await runtime.getServiceLoadPromise(NOTES_SERVICE_TYPE);
  const message = (text: string): Memory => ({
    id: stringToUuid(directory + text),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: stringToUuid(`${directory}room`),
    content: { text, source: "test" },
  });
  return { runtime, message };
}

const envelope = (userRequest: string, document: string): string =>
  [
    "Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
    "",
    "<contextual_documents>",
    `<source title="doc" similarity="0.900">`,
    document,
    "</source>",
    "</contextual_documents>",
    "",
    "<user_request>",
    userRequest,
    "</user_request>",
  ].join("\n");

describe("named notes match the user's words, not the document envelope", () => {
  it("does not surface a note named only inside a retrieved document", async () => {
    const f = await fixture();
    const result = await namedNotesProvider.get(
      f.runtime,
      f.message(
        envelope(
          "what is the weather today?",
          "The Secret project plan covers the launch timeline.",
        ),
      ),
      { values: {}, data: {}, text: "" },
    );
    expect(result.text).toBe("");
    expect(result.data?.namedNotes ?? []).toEqual([]);
  });

  it("still surfaces a note the user names in their own words", async () => {
    const f = await fixture();
    const result = await namedNotesProvider.get(
      f.runtime,
      f.message("please update the Secret project plan"),
      { values: {}, data: {}, text: "" },
    );
    expect(result.text).toContain("SECRET-NOTE-BODY");
    expect(
      (result.data?.namedNotes as { title?: string }[] | undefined)?.length,
    ).toBe(1);
  });
});
