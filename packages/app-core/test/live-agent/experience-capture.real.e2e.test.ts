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
import {
  type Experience,
  ExperienceType,
  OutcomeType,
} from "../../../typescript/src/features/advanced-capabilities/experience/types.ts";

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

type ExpectedRecordedExperience = Partial<
  Pick<
    Experience,
    | "action"
    | "confidence"
    | "context"
    | "domain"
    | "importance"
    | "learning"
    | "outcome"
    | "result"
    | "tags"
    | "type"
  >
>;

type ExtractionScenario = {
  name: string;
  recentTexts: string[];
  extraction: Extraction[];
  expectedRecordedDelta: number;
  expectedExperiences?: ExpectedRecordedExperience[];
  triggerEntityId?: UUID;
  messageCountBeforeTrigger?: string;
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
  options: Omit<ExtractionScenario, "name">,
): Promise<Experience[]> {
  const before = await service.listExperiences({ limit: 100 });
  const beforeIds = new Set(before.map((experience) => experience.id));
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
    return [];
  }

  if (options.recentTexts.length >= 3) {
    runtime.queueExtraction(options.extraction);
  }

  await experienceEvaluator.handler(runtime as never, triggerMessage);

  const after = await service.listExperiences({ limit: 100 });
  expect(after).toHaveLength(before.length + options.expectedRecordedDelta);
  const recorded = after.filter((experience) => !beforeIds.has(experience.id));
  expect(recorded).toHaveLength(options.expectedRecordedDelta);

  if (options.expectedExperiences) {
    expect(recorded).toHaveLength(options.expectedExperiences.length);
    for (const [index, expected] of options.expectedExperiences.entries()) {
      const actual = recorded[index];
      expect(
        actual,
        `expected recorded experience at index ${index}`,
      ).toBeTruthy();
      if (!actual) continue;
      expectExperienceToMatch(actual, expected);
    }
  }

  return recorded;
}

function expectExperienceToMatch(
  actual: Experience,
  expected: ExpectedRecordedExperience,
): void {
  if (expected.action !== undefined) {
    expect(actual.action).toBe(expected.action);
  }
  if (expected.confidence !== undefined) {
    expect(actual.confidence).toBe(expected.confidence);
  }
  if (expected.context !== undefined) {
    expect(actual.context).toBe(expected.context);
  }
  if (expected.domain !== undefined) {
    expect(actual.domain).toBe(expected.domain);
  }
  if (expected.importance !== undefined) {
    expect(actual.importance).toBe(expected.importance);
  }
  if (expected.learning !== undefined) {
    expect(actual.learning).toBe(expected.learning);
  }
  if (expected.outcome !== undefined) {
    expect(actual.outcome).toBe(expected.outcome);
  }
  if (expected.result !== undefined) {
    expect(actual.result).toBe(expected.result);
  }
  if (expected.tags !== undefined) {
    expect(actual.tags).toEqual(expected.tags);
  }
  if (expected.type !== undefined) {
    expect(actual.type).toBe(expected.type);
  }
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

  it("runs extraction scenarios, verifies recorded fields, skips non-experiences, and retrieves the right result 3/3 times", async () => {
    const formedScenarios: ExtractionScenario[] = [
      {
        name: "dependency correction",
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
        expectedExperiences: [
          {
            action: "pattern_recognition",
            confidence: 0.9,
            context: "Debugging a local Python script failure.",
            domain: "shell",
            importance: 0.8,
            learning:
              "Install dependencies before rerunning Python scripts after ModuleNotFoundError for pandas.",
            outcome: OutcomeType.POSITIVE,
            result:
              "Install dependencies before rerunning Python scripts after ModuleNotFoundError for pandas.",
            tags: ["extracted", "novel", ExperienceType.CORRECTION],
            type: ExperienceType.CORRECTION,
          },
        ],
      },
      {
        name: "terminal discovery",
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
        expectedExperiences: [
          {
            action: "pattern_recognition",
            confidence: 0.9,
            context: "Inspecting API payloads from the CLI.",
            domain: "shell",
            importance: 0.8,
            learning:
              "Use jq to parse JSON responses directly in the terminal when inspecting API output.",
            outcome: OutcomeType.NEUTRAL,
            result:
              "Use jq to parse JSON responses directly in the terminal when inspecting API output.",
            tags: ["extracted", "novel", ExperienceType.DISCOVERY],
            type: ExperienceType.DISCOVERY,
          },
        ],
      },
      {
        name: "environment restart learning",
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
        expectedExperiences: [
          {
            action: "pattern_recognition",
            confidence: 0.88,
            context: "Local development after environment changes.",
            domain: "coding",
            importance: 0.8,
            learning:
              "Restart the dev server after changing environment variables so the new values are loaded.",
            outcome: OutcomeType.NEUTRAL,
            result:
              "Restart the dev server after changing environment variables so the new values are loaded.",
            tags: ["extracted", "novel", ExperienceType.LEARNING],
            type: ExperienceType.LEARNING,
          },
        ],
      },
      {
        name: "sensitive-context sanitization",
        recentTexts: [
          "I almost included /Users/shawwalters/secrets.env in notes.",
          "The debug output included 10.20.30.40 and shaw@example.com.",
          "I redacted them before using the note.",
        ],
        extraction: [
          {
            type: "LEARNING",
            learning:
              "Redact /Users/shawwalters/secrets.env and shaw@example.com before saving debug notes.",
            context:
              "Debugging from /Users/shawwalters/project with shaw@example.com and 10.20.30.40.",
            confidence: 0.93,
          },
        ],
        expectedRecordedDelta: 1,
        expectedExperiences: [
          {
            action: "pattern_recognition",
            confidence: 0.9,
            context:
              "Debugging from /Users/[USER]/project with [EMAIL] and [IP].",
            domain: "coding",
            importance: 0.8,
            learning:
              "Redact /Users/[USER]/secrets.env and [EMAIL] before saving debug notes.",
            outcome: OutcomeType.NEUTRAL,
            result:
              "Redact /Users/shawwalters/secrets.env and shaw@example.com before saving debug notes.",
            tags: ["extracted", "novel", ExperienceType.LEARNING],
            type: ExperienceType.LEARNING,
          },
        ],
      },
    ];

    const skippedScenarios: ExtractionScenario[] = [
      {
        name: "low confidence hunch",
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
      },
      {
        name: "user-authored trigger",
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
      },
      {
        name: "duplicate dependency correction",
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
      },
      {
        name: "conversation too short",
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
      },
    ];

    for (const scenario of formedScenarios) {
      await runExtractionCase(runtime, experienceService, scenario);
    }

    for (const scenario of skippedScenarios) {
      await runExtractionCase(runtime, experienceService, scenario);
    }

    const allExperiences = await experienceService.listExperiences({ limit: 20 });
    expect(allExperiences).toHaveLength(formedScenarios.length);

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
