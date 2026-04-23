import crypto from "node:crypto";
import {
  createMessageMemory,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experienceEvaluator } from "../../../typescript/src/features/advanced-capabilities/experience/evaluators/experienceEvaluator.ts";
import { ExperienceService } from "../../../typescript/src/features/advanced-capabilities/experience/service.ts";

type Extraction = {
  type: string;
  learning: string;
  context: string;
  confidence: number;
};

type RuntimeHarness = {
  agentId: UUID;
  getMemories: (query: {
    entityId?: UUID;
    roomId?: UUID;
    tableName: string;
    limit?: number;
    unique?: boolean;
  }) => Promise<Memory[]>;
  upsertMemory: (memory: Memory, tableName?: string) => Promise<void>;
  deleteMemory: (id: UUID) => Promise<void>;
  useModel: (
    modelType: string,
    params: { prompt?: string; text?: string },
  ) => Promise<string | number[]>;
  getCache: (key: string) => Promise<string | null>;
  setCache: (key: string, value: string) => Promise<void>;
  getService: (serviceType: string) => ExperienceService | null;
  getSetting: (key: string) => string | undefined;
  queueExtraction: (extractions: Extraction[]) => void;
};

function nextUuid(label: string): UUID {
  return stringToUuid(`${label}-${crypto.randomUUID()}`);
}

function embeddingForText(text: string): number[] {
  const normalized = text.toLowerCase();
  const dimensions = [0, 0, 0];

  if (
    normalized.includes("pandas") ||
    normalized.includes("dependency") ||
    normalized.includes("dependencies") ||
    normalized.includes("modulenotfounderror")
  ) {
    dimensions[0] += 1;
  }
  if (normalized.includes("jq") || normalized.includes("json")) {
    dimensions[1] += 1;
  }
  if (
    normalized.includes("restart") ||
    normalized.includes("environment variable") ||
    normalized.includes("env var")
  ) {
    dimensions[2] += 1;
  }

  if (dimensions.every((value) => value === 0)) {
    return [0.01, 0.01, 0.01];
  }

  return dimensions;
}

function makeMessage(roomId: UUID, entityId: UUID, text: string): Memory {
  return createMessageMemory({
    id: nextUuid("experience-message"),
    roomId,
    entityId,
    content: {
      text,
      source: "client_chat",
    },
  });
}

async function flushServiceLoad(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createExperienceRuntimeHarness(): {
  runtime: RuntimeHarness;
  service: ExperienceService;
} {
  const memoriesByTable = new Map<string, Memory[]>();
  const cache = new Map<string, string>();
  const settings = new Map<string, string>([["AUTO_RECORD_THRESHOLD", "0.6"]]);
  const extractionQueue: string[] = [];
  const agentId = nextUuid("experience-agent");
  let service: ExperienceService | null = null;

  const runtime: RuntimeHarness = {
    agentId,
    async getMemories(query) {
      const rows = [...(memoriesByTable.get(query.tableName) ?? [])];
      const filtered = rows.filter((memory) => {
        if (query.entityId && memory.entityId !== query.entityId) {
          return false;
        }
        if (query.roomId && memory.roomId !== query.roomId) {
          return false;
        }
        return true;
      });
      return filtered.slice(-(query.limit ?? filtered.length));
    },
    async upsertMemory(memory, tableName = "messages") {
      const rows = [...(memoriesByTable.get(tableName) ?? [])];
      const existingIndex = rows.findIndex((row) => row.id === memory.id);
      if (existingIndex >= 0) {
        rows[existingIndex] = memory;
      } else {
        rows.push(memory);
      }
      memoriesByTable.set(tableName, rows);
    },
    async deleteMemory(id) {
      for (const [tableName, rows] of memoriesByTable.entries()) {
        memoriesByTable.set(
          tableName,
          rows.filter((row) => row.id !== id),
        );
      }
    },
    async useModel(modelType, params) {
      if (modelType === ModelType.TEXT_EMBEDDING) {
        return embeddingForText(params.text ?? "");
      }
      if (modelType === ModelType.TEXT_SMALL) {
        const next = extractionQueue.shift();
        if (!next) {
          throw new Error(
            `No queued extraction response for ${ModelType.TEXT_SMALL}`,
          );
        }
        return next;
      }
      throw new Error(`Unsupported model type in test harness: ${modelType}`);
    },
    async getCache(key) {
      return cache.get(key) ?? null;
    },
    async setCache(key, value) {
      cache.set(key, value);
    },
    getService(serviceType) {
      return serviceType === "EXPERIENCE" ? service : null;
    },
    getSetting(key) {
      return settings.get(key);
    },
    queueExtraction(extractions) {
      extractionQueue.push(JSON.stringify(extractions));
    },
  };

  service = new ExperienceService(
    runtime as unknown as ConstructorParameters<typeof ExperienceService>[0],
  );

  return { runtime, service };
}

async function seedConversation(
  runtime: RuntimeHarness,
  roomId: UUID,
  entityId: UUID,
  texts: string[],
): Promise<Memory[]> {
  const messages = texts.map((text) => makeMessage(roomId, entityId, text));
  for (const message of messages) {
    await runtime.upsertMemory(message, "messages");
  }
  return messages;
}

async function runExtractionCase(
  runtime: RuntimeHarness,
  service: ExperienceService,
  options: {
    recentTexts: string[];
    extraction: Extraction[];
    expectedRecordedDelta: number;
    triggerEntityId?: UUID;
    messageCountBeforeTrigger?: string;
  },
): Promise<void> {
  const before = await service.listExperiences({ limit: 100 });
  const roomId = nextUuid("experience-room");
  const triggerEntityId = options.triggerEntityId ?? runtime.agentId;
  const recentMessages = await seedConversation(
    runtime,
    roomId,
    triggerEntityId,
    options.recentTexts,
  );
  const triggerMessage = recentMessages[recentMessages.length - 1];

  if (!triggerMessage) {
    throw new Error("Expected at least one trigger message");
  }

  await runtime.setCache(
    "experience-extraction:last-message-count",
    options.messageCountBeforeTrigger ?? "24",
  );

  const shouldRun = await experienceEvaluator.validate(
    runtime as never,
    triggerMessage,
  );
  expect(shouldRun).toBe(triggerEntityId === runtime.agentId);

  if (!shouldRun) {
    const after = await service.listExperiences({ limit: 100 });
    expect(after).toHaveLength(before.length);
    return;
  }

  if (options.recentTexts.length >= 3) {
    runtime.queueExtraction(options.extraction);
  }

  await experienceEvaluator.handler(runtime as never, triggerMessage);

  const after = await service.listExperiences({ limit: 100 });
  expect(after).toHaveLength(before.length + options.expectedRecordedDelta);
}

describe("Experience Capture E2E", () => {
  let runtime: RuntimeHarness;
  let experienceService: ExperienceService;

  beforeAll(async () => {
    const harness = createExperienceRuntimeHarness();
    runtime = harness.runtime;
    experienceService = harness.service;
    await flushServiceLoad();
  });

  afterAll(async () => {
    await experienceService.stop();
  });

  it("records expected experiences, skips non-experiences, and retrieves the right result 3/3 times", async () => {
    await runExtractionCase(runtime, experienceService, {
      recentTexts: [
        "Let me run the Python script.",
        "It failed with ModuleNotFoundError for pandas.",
        "Installing dependencies fixed it and the script completed.",
      ],
      extraction: [
        {
          type: "CORRECTION",
          learning:
            "Install dependencies before rerunning Python scripts after ModuleNotFoundError for pandas.",
          context: "Debugging a local Python script failure.",
          confidence: 0.92,
        },
      ],
      expectedRecordedDelta: 1,
    });

    await runExtractionCase(runtime, experienceService, {
      recentTexts: [
        "I need to inspect API output quickly from the terminal.",
        "jq is installed here and can parse JSON cleanly.",
        "Using jq made the payload inspection much faster.",
      ],
      extraction: [
        {
          type: "DISCOVERY",
          learning:
            "Use jq to parse JSON responses directly in the terminal when inspecting API output.",
          context: "Inspecting API payloads from the CLI.",
          confidence: 0.9,
        },
      ],
      expectedRecordedDelta: 1,
    });

    await runExtractionCase(runtime, experienceService, {
      recentTexts: [
        "I changed an environment variable for the dev server.",
        "The app still showed stale values until I restarted it.",
        "Restarting the dev server picked up the new environment variable.",
      ],
      extraction: [
        {
          type: "LEARNING",
          learning:
            "Restart the dev server after changing environment variables so the new values are loaded.",
          context: "Local development after environment changes.",
          confidence: 0.88,
        },
      ],
      expectedRecordedDelta: 1,
    });

    await runExtractionCase(runtime, experienceService, {
      recentTexts: [
        "A user asked me to remember a weak hunch.",
        "I think it might matter later, but I am not sure.",
        "This is too uncertain to record confidently.",
      ],
      extraction: [
        {
          type: "LEARNING",
          learning: "Maybe this uncertain hunch matters later.",
          context: "A low-confidence conversation snippet.",
          confidence: 0.2,
        },
      ],
      expectedRecordedDelta: 0,
    });

    await runExtractionCase(runtime, experienceService, {
      recentTexts: [
        "The user sent a message about pandas dependencies.",
        "This was a user-authored note, not an agent-authored message.",
        "The evaluator should not run on user messages.",
      ],
      triggerEntityId: nextUuid("experience-user"),
      extraction: [
        {
          type: "LEARNING",
          learning:
            "This should never be recorded because the trigger is not from the agent.",
          context: "User-authored message should not trigger extraction.",
          confidence: 0.99,
        },
      ],
      expectedRecordedDelta: 0,
    });

    await runExtractionCase(runtime, experienceService, {
      recentTexts: [
        "I saw the pandas ModuleNotFoundError again.",
        "Installing the dependency fixed the same Python script.",
        "This is the same lesson as before.",
      ],
      extraction: [
        {
          type: "CORRECTION",
          learning:
            "Install dependencies before rerunning Python scripts after ModuleNotFoundError for pandas.",
          context: "Revisiting the same dependency fix.",
          confidence: 0.95,
        },
      ],
      expectedRecordedDelta: 0,
    });

    await runExtractionCase(runtime, experienceService, {
      recentTexts: [
        "Only one message exists here.",
        "Two messages are not enough for extraction.",
      ],
      extraction: [
        {
          type: "LEARNING",
          learning:
            "This should not record because there are fewer than three messages.",
          context: "Conversation too short.",
          confidence: 0.99,
        },
      ],
      expectedRecordedDelta: 0,
    });

    const allExperiences = await experienceService.listExperiences({ limit: 20 });
    expect(allExperiences).toHaveLength(3);

    const retrievalCases = [
      {
        query:
          "How should I fix ModuleNotFoundError for pandas before running the Python script again?",
        expectedLearning:
          "Install dependencies before rerunning Python scripts after ModuleNotFoundError for pandas.",
      },
      {
        query:
          "What should I use to parse JSON responses quickly in the terminal?",
        expectedLearning:
          "Use jq to parse JSON responses directly in the terminal when inspecting API output.",
      },
      {
        query:
          "What do I need to do after changing an environment variable in local development?",
        expectedLearning:
          "Restart the dev server after changing environment variables so the new values are loaded.",
      },
    ] as const;

    let hits = 0;
    for (const retrievalCase of retrievalCases) {
      const results = await experienceService.queryExperiences({
        query: retrievalCase.query,
        limit: 1,
      });
      expect(results).toHaveLength(1);
      if (results[0]?.learning === retrievalCase.expectedLearning) {
        hits += 1;
      }
    }

    expect(hits).toBe(3);
    expect(`${hits}/${retrievalCases.length}`).toBe("3/3");
  });
});
