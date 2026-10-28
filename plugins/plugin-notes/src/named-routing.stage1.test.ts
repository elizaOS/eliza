import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  CONTEXT_ROUTING_METADATA_KEY,
  type ContextObject,
  createCharacter,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectDiscoverableContext } from "../../plugin-assistant/src/services/message/context-discovery.ts";
import {
  composeResponseState,
  selectV5PlannerStateProviderNames,
  stage1ResponseStateProviderNames,
} from "../../plugin-assistant/src/services/message/provider-state.ts";
import { notesPlugin } from "./plugin.ts";
import { namedNotesProvider, namedNotesRoutingProvider } from "./provider.ts";
import { NOTES_SERVICE_TYPE, NotesService } from "./service.ts";
import { NotesStore } from "./store.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const runtimes: AgentRuntime[] = [],
  directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(root, ".notes-routing-test-"));
  directories.push(directory);
  const service = new NotesService(undefined, {
    store: new NotesStore({ filePath: path.join(directory, "state.json") }),
  });
  await service.initialize();
  const note = await service.createNote({
    content: "Weekend bag\nSECRET-CURRENT-BODY exact text.",
  });
  await service.createNote({
    content: "Unrelated title\nUNRELATED-PRIVATE-BODY",
  });
  const runtime = new AgentRuntime({
    agentId: stringToUuid(directory),
    character: createCharacter({ name: "Routing fixture" }),
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
  runtime.registerProvider(namedNotesProvider);
  runtime.registerProvider(namedNotesRoutingProvider);
  const read = vi.spyOn(service, "snapshot");
  const model = vi.spyOn(runtime, "useModel").mockImplementation(async () => {
    throw Error("No model permitted");
  });
  const message = (text = "What's in Weekend bag?"): Memory => ({
    id: stringToUuid(directory + text),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: stringToUuid(`${directory}room`),
    content: { text, source: "test" },
  });
  return { runtime, service, note, read, model, message };
}
describe("body-free canonical named-note Stage1 routing", () => {
  it("is registered while full named and saved note bodies stay outside the lean allowlist", async () => {
    const f = await fixture();
    expect(
      notesPlugin.providers?.some((p) => p.name === "NAMED_NOTE_ROUTING"),
    ).toBe(true);
    const names = stage1ResponseStateProviderNames(f.runtime, f.message(), [
      "OWNER",
    ]);
    expect(names).toContain("NAMED_NOTE_ROUTING");
    expect(names).not.toContain("NAMED_NOTES");
    expect(names).not.toContain("SAVED_NOTES");
    const state = await composeResponseState(f.runtime, f.message(), true);
    expect(state.text).toContain("Fresh exact named-note reference");
    const raw = JSON.stringify(state);
    for (const secret of [
      "SECRET-CURRENT-BODY",
      "UNRELATED-PRIVATE-BODY",
      f.note.id,
      "Weekend bag",
      f.note.createdAt.toString(),
    ])
      expect(raw).not.toContain(secret);
    expect(state.text.length).toBeLessThan(500);
    expect(f.model).not.toHaveBeenCalled();
  });
  it("cannot leak bodies when discovery is enabled or disabled", async () => {
    const f = await fixture(),
      state = await composeResponseState(f.runtime, f.message(), true);
    const context: ContextObject = {
      id: "named-routing-fixture",
      events: [
        {
          id: "routing",
          type: "provider",
          name: "NAMED_NOTE_ROUTING",
          text: state.data.providers.NAMED_NOTE_ROUTING.text,
        },
      ],
    };
    for (const enabled of [false, true]) {
      const output = enabled
        ? projectDiscoverableContext(context, state).context
        : context;
      const wire = JSON.stringify(output);
      expect(wire).toContain("Fresh exact named-note reference");
      expect(wire).not.toContain("SECRET-CURRENT-BODY");
      expect(wire).not.toContain("Weekend bag");
      expect(wire).not.toContain(f.note.id);
    }
    expect(f.model).not.toHaveBeenCalled();
  });
  it("does no Notes source read for non-owner, unknown, or private audience", async () => {
    const f = await fixture();
    for (const roles of [undefined, ["USER"], ["NONE"]] as const) {
      const names = stage1ResponseStateProviderNames(
        f.runtime,
        f.message(),
        roles,
      );
      expect(names).not.toContain("NAMED_NOTE_ROUTING");
      await f.runtime.composeState(f.message(), names, true, true);
    }
    expect(f.read).not.toHaveBeenCalled();
    f.runtime.registerProvider({
      ...namedNotesRoutingProvider,
      override: true,
      private: true,
    });
    expect(
      stage1ResponseStateProviderNames(f.runtime, f.message(), ["OWNER"]),
    ).not.toContain("NAMED_NOTE_ROUTING");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
  });
  it("honors complete explicit context gates and never unions different routing decisions", async () => {
    const f = await fixture();
    const msg = f.message();
    msg.content.metadata = {
      [CONTEXT_ROUTING_METADATA_KEY]: { primaryContext: "general" },
    };
    for (const gate of [
      { noneOf: ["general"] },
      { anyOf: ["world"] },
      { allOf: ["general", "notes"] },
    ]) {
      f.runtime.registerProvider({
        ...namedNotesRoutingProvider,
        override: true,
        contextGate: gate,
      });
      const names = stage1ResponseStateProviderNames(f.runtime, msg, ["OWNER"]);
      expect(names).not.toContain("NAMED_NOTE_ROUTING");
      await f.runtime.composeState(msg, names, true, true);
    }
    const conflict = f.message();
    conflict.content.metadata = {
      [CONTEXT_ROUTING_METADATA_KEY]: { primaryContext: "general" },
    };
    conflict.metadata = {
      [CONTEXT_ROUTING_METADATA_KEY]: { primaryContext: "notes" },
    };
    f.runtime.registerProvider({
      ...namedNotesRoutingProvider,
      override: true,
      contextGate: { allOf: ["general", "notes"] },
    });
    expect(
      stage1ResponseStateProviderNames(f.runtime, conflict, ["OWNER"]),
    ).not.toContain("NAMED_NOTE_ROUTING");
    expect(f.read).not.toHaveBeenCalled();
    f.runtime.registerProvider({
      ...namedNotesRoutingProvider,
      override: true,
      contextGate: { allOf: ["general", "notes"] },
    });
    msg.content.metadata = {
      [CONTEXT_ROUTING_METADATA_KEY]: {
        primaryContext: "general",
        secondaryContexts: ["notes"],
      },
    };
    expect(
      stage1ResponseStateProviderNames(f.runtime, msg, ["OWNER"]),
    ).toContain("NAMED_NOTE_ROUTING");
    expect(f.model).not.toHaveBeenCalled();
  });
  it("does not read the store for an empty turn", async () => {
    const f = await fixture();
    const result = await namedNotesRoutingProvider.get(
      f.runtime,
      f.message("   "),
      { values: {}, data: {}, text: "" },
    );
    expect(result.text).toBe("");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
  });
  it("does not fabricate a match for unrelated text or a source failure", async () => {
    const f = await fixture();
    const absent = await namedNotesRoutingProvider.get(
      f.runtime,
      f.message("Discuss an unrelated topic."),
      { values: {}, data: {}, text: "" },
    );
    expect(absent.text).toBe("");
    expect(absent.data?.namedNoteMatchAvailable).toBe(false);
    f.read.mockImplementation(() => {
      throw Error("Synthetic unavailable Notes store");
    });
    const failed = await namedNotesRoutingProvider.get(f.runtime, f.message(), {
      values: {},
      data: {},
      text: "",
    });
    expect(failed.data?.namedNoteMatchAvailable).toBeNull();
    expect(failed.text).toContain("unconfirmed");
    expect(failed.text).not.toContain("SECRET");
    expect(f.model).not.toHaveBeenCalled();
  });
  it("keeps historical and mixed intent neutral and does not add planner or model calls", async () => {
    const f = await fixture();
    const outputs = [];
    for (const text of [
      "What's in Weekend bag?",
      "What did I say about Weekend bag last year?",
      "Compare Weekend bag with what I discussed yesterday.",
    ])
      outputs.push(
        await namedNotesRoutingProvider.get(f.runtime, f.message(text), {
          values: {},
          data: {},
          text: "",
        }),
      );
    expect(
      outputs.every(
        (r) =>
          r.text === outputs[0].text &&
          r.data?.namedNoteMatchAvailable === true,
      ),
    ).toBe(true);
    expect(outputs[0].text).toContain(
      "does not determine current, historical, or mixed intent",
    );
    expect(outputs[0].text).not.toMatch(
      /ACTION_PLANNER|NOTES_GET|must|always route/,
    );
    expect(f.model).not.toHaveBeenCalled();
  });
  it("uses fresh store state while leaving complete planning evidence unchanged", async () => {
    const f = await fixture();
    await composeResponseState(f.runtime, f.message(), true);
    const before = f.service.snapshot();
    await f.service.updateNote(
      f.note.id,
      { body: "Changed body after routing" },
      before.revision,
    );
    const names = selectV5PlannerStateProviderNames({
      runtime: f.runtime,
      message: f.message(),
      selectedContexts: ["notes"],
      userRoles: ["OWNER"],
    });
    expect(names).toContain("NAMED_NOTES");
    const complete = await namedNotesProvider.get(f.runtime, f.message(), {
      values: {},
      data: {},
      text: "",
    });
    expect(complete.text).toContain("Changed body after routing");
    expect(complete.text).not.toContain("SECRET-CURRENT-BODY");
    expect(complete.text).not.toContain("UNRELATED-PRIVATE-BODY");
    const hint = await namedNotesRoutingProvider.get(f.runtime, f.message(), {
      values: {},
      data: {},
      text: "",
    });
    expect(hint.text).not.toContain("Changed body");
    expect(hint.data?.namedNoteMatchAvailable).toBe(true);
    expect(f.model).not.toHaveBeenCalled();
  });
});
