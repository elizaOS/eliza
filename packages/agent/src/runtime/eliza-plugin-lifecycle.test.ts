/**
 * Exercises the built-in plugin lifecycle with its registration boundaries
 * observed directly, while keeping background workers and media hooks inert.
 */
import {
  type CommandDefinition,
  CommandRegistryService,
  Service,
  ServiceType,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestRuntime,
  type TestRuntime,
} from "../__tests__/plugin-lifecycle-test-utils.ts";

declare module "@elizaos/core" {
  interface ServiceTypeRegistry {
    AGENT_SKILLS_SERVICE: "AGENT_SKILLS_SERVICE";
    ELIZA_CHARACTER_PERSISTENCE: "eliza_character_persistence";
    ELIZA_PERMISSIONS_REGISTRY: "eliza_permissions_registry";
    MEDIA_GENERATION: "media_generation";
  }
}

class TestSkillsService extends Service {
  readonly capabilityDescription = "Loaded test skills";

  constructor(
    runtime: TestRuntime,
    private readonly skills: Array<{
      slug: string;
      name: string;
      description: string;
    }>,
  ) {
    super(runtime);
  }

  getLoadedSkills() {
    return this.skills;
  }

  async stop() {}
}

class TestCommandRegistry extends CommandRegistryService {
  readonly capabilityDescription = "Registered test commands";
  readonly commands: CommandDefinition[] = [];

  register(command: CommandDefinition) {
    this.commands.push(command);
  }

  list() {
    return [...this.commands];
  }

  async stop() {}
}

class TestStoppableService extends Service {
  readonly capabilityDescription = "Lifecycle stop observer";
  readonly stop = vi.fn(async () => {});
}

function installTestServices(
  runtime: TestRuntime,
  skills: ConstructorParameters<typeof TestSkillsService>[1],
) {
  const skillsService = new TestSkillsService(runtime, skills);
  const commands = new TestCommandRegistry(runtime);
  runtime.services.set("AGENT_SKILLS_SERVICE", [skillsService]);
  runtime.services.set(ServiceType.COMMANDS, [commands]);
  return { commands };
}

const lifecycle = vi.hoisted(() => ({
  registerTriggerTaskWorker: vi.fn(),
  migrateWorkbenchScheduleTags: vi.fn(),
  registerErrorEscalation: vi.fn(),
  setCustomActionsRuntime: vi.fn(),
  registerMediaPipelineHook: vi.fn(),
  registerMediaGcTask: vi.fn(),
  registerAttachmentKnowledgeIngestHook: vi.fn(),
  registerAttachmentKnowledgeBackfillTask: vi.fn(),
}));

vi.mock("../triggers/runtime.ts", () => ({
  registerTriggerTaskWorker: lifecycle.registerTriggerTaskWorker,
}));
vi.mock("../triggers/workbench-migration.ts", () => ({
  migrateWorkbenchScheduleTags: lifecycle.migrateWorkbenchScheduleTags,
}));
vi.mock("./error-escalation.ts", () => ({
  registerErrorEscalation: lifecycle.registerErrorEscalation,
}));
vi.mock("./custom-actions.ts", () => ({
  setCustomActionsRuntime: lifecycle.setCustomActionsRuntime,
}));
vi.mock("../api/media-runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/media-runtime.ts")>()),
  registerMediaPipelineHook: lifecycle.registerMediaPipelineHook,
  registerMediaGcTask: lifecycle.registerMediaGcTask,
}));
vi.mock("../api/attachment-knowledge-ingest.ts", () => ({
  registerAttachmentKnowledgeIngestHook:
    lifecycle.registerAttachmentKnowledgeIngestHook,
}));
vi.mock("../api/attachment-knowledge-backfill.ts", () => ({
  registerAttachmentKnowledgeBackfillTask:
    lifecycle.registerAttachmentKnowledgeBackfillTask,
}));

import { createElizaPlugin } from "./eliza-plugin.ts";

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle.migrateWorkbenchScheduleTags.mockResolvedValue(undefined);
});

describe("createElizaPlugin lifecycle", () => {
  it("registers runtime hooks and publishes loaded skills as commands", async () => {
    const runtime = createTestRuntime();
    const { commands } = installTestServices(runtime, [
      {
        slug: "Research",
        name: "Research",
        description: "Investigate a topic and return sourced findings",
      },
    ]);
    const permissions = new TestStoppableService(runtime);
    const mediaGeneration = new TestStoppableService(runtime);
    const characterPersistence = new TestStoppableService(runtime);
    const agentEvent = new TestStoppableService(runtime);
    runtime.services.set("eliza_permissions_registry", [permissions]);
    runtime.services.set(ServiceType.MEDIA_GENERATION, [mediaGeneration]);
    runtime.services.set("eliza_character_persistence", [characterPersistence]);
    runtime.services.set(ServiceType.AGENT_EVENT, [agentEvent]);

    const plugin = createElizaPlugin({
      workspaceDir: "/tmp/eliza-plugin-workspace",
      sessionStorePath: "/tmp/eliza-plugin-sessions.json",
      agentId: "coverage-agent",
    });
    await plugin.init?.({}, runtime);

    expect(lifecycle.registerTriggerTaskWorker).toHaveBeenCalledWith(runtime);
    expect(lifecycle.registerErrorEscalation).toHaveBeenCalledWith(runtime);
    expect(lifecycle.setCustomActionsRuntime).toHaveBeenCalledWith(runtime);
    expect(lifecycle.registerMediaPipelineHook).toHaveBeenCalledWith(runtime);
    expect(lifecycle.registerMediaGcTask).toHaveBeenCalledWith(runtime);
    expect(
      lifecycle.registerAttachmentKnowledgeIngestHook,
    ).toHaveBeenCalledWith(runtime);
    expect(
      lifecycle.registerAttachmentKnowledgeBackfillTask,
    ).toHaveBeenCalledWith(runtime);
    expect(commands.list()).toContainEqual(
      expect.objectContaining({
        key: "skill-research",
        textAliases: ["/research"],
        acceptsArgs: true,
      }),
    );

    await plugin.dispose?.(runtime);
    for (const service of [
      permissions,
      mediaGeneration,
      characterPersistence,
      agentEvent,
    ]) {
      expect(service.stop).toHaveBeenCalledOnce();
    }
  });

  it("reports migration failures without blocking the remaining init hooks", async () => {
    const migrationFailure = new Error("migration failed");
    lifecycle.migrateWorkbenchScheduleTags.mockRejectedValueOnce(
      migrationFailure,
    );
    const runtime = createTestRuntime();
    installTestServices(runtime, [
      { slug: "empty", name: "Empty", description: "" },
    ]);
    const warn = vi.spyOn(runtime.logger, "warn").mockImplementation(() => {});

    await createElizaPlugin({
      workspaceDir: "/tmp/eliza-plugin-workspace",
      sessionStorePath: "/tmp/eliza-plugin-sessions.json",
    }).init?.({}, runtime);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        { src: "trigger-runtime", err: String(migrationFailure) },
        "Workbench schedule-tag migration failed",
      );
    });
    expect(lifecycle.registerErrorEscalation).toHaveBeenCalledWith(runtime);
  });
});
