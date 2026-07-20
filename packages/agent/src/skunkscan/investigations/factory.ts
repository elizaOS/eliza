import {
  CreateInvestigationInput,
  InvestigationCase,
} from "./types";

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .substring(2, 10)}`;
}

export function createInvestigation(
  input: CreateInvestigationInput
): InvestigationCase {
  const now = new Date().toISOString();

  return {
    id: generateId("inv"),

    title: input.title,

    description: input.description,

    schemaVersion: "1.0",

    revision: 1,

    origin: input.origin ?? "system",

    status: "draft",

    priority: input.priority ?? "medium",

    subjects: [],

    evidence: [],

    findings: [],

    notes: [],

    auditTrail: [
      {
        id: generateId("audit"),
        action: "investigation_created",
        description: "Investigation created.",
        actor: input.createdBy ?? "system",
        createdAt: now,
      },
    ],

    executions: [
      {
        runId: generateId("run"),
        runType: "initial",
        startedAt: now,
        completedAt: now,
        successful: true,
      },
    ],

    tags: input.tags ?? [],

    createdBy: input.createdBy ?? "system",

    createdAt: now,

    updatedAt: now,

    lastRunAt: now,
  };
}
