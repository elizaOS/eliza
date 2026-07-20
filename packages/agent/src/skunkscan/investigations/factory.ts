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

    tags: input.tags ?? [],

    createdBy: input.createdBy ?? "system",

    createdAt: now,

    updatedAt: now,
  };
}
