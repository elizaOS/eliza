/** Actual Notes persistence and core lifecycle, with isolated temporary state directories. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
} from "@elizaos/core";
import { NotesService, notesPlugin } from "@elizaos/plugin-notes";
import { initializeTestRuntime } from "@elizaos/testing/in-memory-adapter";
import { expect, it } from "vitest";
import { installRuntimePluginLifecycle } from "../runtime/plugin-lifecycle.ts";
import { getView, listViews } from "./views-registry.ts";
import { dispatchViewInteract } from "./views-routes.ts";

async function notesRuntime(stateDir: string) {
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Same Notes agent" }),
    enableAutonomy: false,
  });
  class IsolatedNotesService extends NotesService {
    static override async start(owner: IAgentRuntime): Promise<NotesService> {
      const service = new NotesService(owner, { stateDir });
      await service.initialize();
      return service;
    }
  }
  installRuntimePluginLifecycle(runtime);
  await initializeTestRuntime(runtime, { skipMigrations: true });
  await runtime.registerPlugin({
    ...notesPlugin,
    services: [IsolatedNotesService],
  });
  const service = await runtime.getServiceLoadPromise(NotesService.serviceType);
  if (!(service instanceof NotesService))
    throw new Error("Notes service did not start");
  return { runtime, service };
}

it("isolates actual Notes mutations for equal agent IDs and rejects cross-runtime and retired entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "notes-view-owners-"));
  const a = await notesRuntime(path.join(dir, "a"));
  const b = await notesRuntime(path.join(dir, "b"));
  try {
    expect(a.runtime.agentId).toBe(b.runtime.agentId);
    const entry = getView(a.runtime, "notes");
    if (!entry) throw new Error("Notes view did not register");
    const created = await dispatchViewInteract(
      entry,
      "notes",
      "create-note",
      { content: "A private note\nOnly runtime A owns this." },
      { runtime: a.runtime, userRoles: ["OWNER"] },
    );
    expect(created.success).toBe(true);
    expect(a.service.listNotes()).toHaveLength(1);
    expect(b.service.listNotes()).toEqual([]);
    const saved = await readFile(a.service.store.filePath, "utf8");
    expect(JSON.parse(saved).notes).toEqual(a.service.listNotes());
    await expect(
      dispatchViewInteract(
        entry,
        "notes",
        "create-note",
        { content: "Wrong owner" },
        { runtime: b.runtime, userRoles: ["OWNER"] },
      ),
    ).rejects.toMatchObject({ code: "VIEW_INSTALLATION_INVALID" });
    const denied = await dispatchViewInteract(
      entry,
      "notes",
      "create-note",
      { content: "Denied role" },
      { runtime: a.runtime, userRoles: [] },
    );
    expect(denied.success).toBe(false);
    await a.runtime.unloadPlugin(notesPlugin.name);
    await expect(
      dispatchViewInteract(
        entry,
        "notes",
        "create-note",
        { content: "Retired owner" },
        { runtime: a.runtime, userRoles: ["OWNER"] },
      ),
    ).rejects.toMatchObject({ code: "VIEW_INSTALLATION_INVALID" });
    expect(await readFile(a.service.store.filePath, "utf8")).toBe(saved);
    expect(b.service.listNotes()).toEqual([]);
  } finally {
    await Promise.all([a.runtime.stop(), b.runtime.stop()]);
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["unload", "reload", "stop"] as const)(
  "%s fences an actual plugin registration before its suspended init can publish views",
  async (operation) => {
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "Pending views" }),
      enableAutonomy: false,
    });
    installRuntimePluginLifecycle(runtime);
    await initializeTestRuntime(runtime, { skipMigrations: true });
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      const registration = runtime.registerPlugin({
        name: "pending-view",
        description: "Registration barrier",
        views: [{ id: "pending", label: "Pending" }],
        init: async () => {
          entered();
          await barrier;
        },
      });
      const rejected = expect(registration).rejects.toMatchObject({
        code:
          operation === "stop"
            ? "RUNTIME_STOPPED_DURING_PLUGIN_REGISTRATION"
            : "VIEW_INSTALLATION_INVALID",
      });
      await started;
      const mutation =
        operation === "stop"
          ? runtime.stop()
          : operation === "reload"
            ? runtime.reloadPlugin({
                name: "pending-view",
                description: "Replacement",
                views: [{ id: "replacement", label: "Replacement" }],
              })
            : runtime.unloadPlugin("pending-view");
      release();
      await rejected;
      await mutation;
      if (operation === "stop") {
        expect(() => listViews(runtime)).toThrowError(
          expect.objectContaining({ code: "VIEW_REGISTRY_CLOSED" }),
        );
      } else {
        expect(listViews(runtime).map((view) => view.id)).toEqual(
          operation === "reload" ? ["replacement"] : [],
        );
        expect(
          runtime.plugins.some((plugin) => plugin.name === "pending-view"),
        ).toBe(operation === "reload");
      }
    } finally {
      release();
      await runtime.stop();
    }
  },
);
