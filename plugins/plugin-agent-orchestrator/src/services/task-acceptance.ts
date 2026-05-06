import {
  parseToonKeyValue,
  type IAgentRuntime,
  ModelType,
} from "@elizaos/core";
import type { CreateTaskThreadInput } from "./task-registry.js";

export interface TaskAcceptanceCriteriaResult {
  criteria: string[];
  source: "provided" | "model" | "baseline";
}

const MAX_CRITERIA = 7;

function trimCriterion(value: string): string {
  return value
    .replace(/^[\s*-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueCriteria(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(trimCriterion)) {
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= MAX_CRITERIA) break;
  }
  return result;
}

function parseCriteriaResponse(raw: string): string[] {
  const parsedToon = parseToonKeyValue<Record<string, unknown>>(raw);
  if (parsedToon) {
    const rawCriteria = parsedToon.criteria;
    if (Array.isArray(rawCriteria)) {
      return uniqueCriteria(
        rawCriteria.filter(
          (entry): entry is string => typeof entry === "string",
        ),
      );
    }
    if (typeof rawCriteria === "string") {
      return uniqueCriteria(rawCriteria.split(/\r?\n|,/));
    }
  }

  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const parsed = JSON.parse(candidate) as unknown;
  if (!Array.isArray(parsed)) return [];
  return uniqueCriteria(
    parsed.filter((entry): entry is string => typeof entry === "string"),
  );
}

function plannedSubtasks(input: CreateTaskThreadInput): string[] {
  const subtasks = (input.currentPlan as { subtasks?: unknown } | undefined)
    ?.subtasks;
  if (!Array.isArray(subtasks)) return [];
  return uniqueCriteria(
    subtasks.filter((entry): entry is string => typeof entry === "string"),
  );
}

function getRepo(input: CreateTaskThreadInput): string | null {
  const repo = input.metadata?.repo;
  if (typeof repo !== "string") return null;
  const trimmed = repo.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildBaselineAcceptanceCriteria(
  input: CreateTaskThreadInput,
): string[] {
  const criteria: string[] = [];
  const subtasks = plannedSubtasks(input);

  criteria.push(`Address the full request: ${input.originalRequest}`);
  for (const subtask of subtasks.slice(0, 3)) {
    criteria.push(`Complete this planned subtask: ${subtask}`);
  }
  if (input.kind === "coding" || getRepo(input)) {
    criteria.push(
      "Run the relevant checks for the changed code, or record the exact blocker.",
    );
  }
  criteria.push("Capture concrete completion evidence in the task record.");
  criteria.push(
    "Do not claim completion while any blocker or missing verification remains.",
  );
  return uniqueCriteria(criteria).slice(0, MAX_CRITERIA);
}

function buildAcceptancePrompt(input: CreateTaskThreadInput): string {
  const subtasks = plannedSubtasks(input);
  const planBlock =
    subtasks.length > 0
      ? subtasks.map((task) => `- ${task}`).join("\n")
      : "- none";
  return [
    "Generate task completion criteria for an orchestrated agent task.",
    "Return TOON only with a criteria array of 3 to 7 measurable strings.",
    "Each criterion must be observable and suitable for completion validation.",
    "Avoid generic wording like 'do a good job'.",
    "Use this TOON shape:",
    "criteria[3]:",
    "  Complete the requested implementation.",
    "  Run relevant checks or record exact blockers.",
    "  Capture concrete completion evidence.",
    "",
    `Title: ${input.title}`,
    `Kind: ${input.kind ?? "coding"}`,
    `Original request: ${input.originalRequest}`,
    `Repository: ${getRepo(input) ?? "none"}`,
    "Planned subtasks:",
    planBlock,
    "",
    "Prefer criteria about completed work, verification, evidence, and unresolved blockers.",
  ].join("\n");
}

export async function deriveTaskAcceptanceCriteria(
  runtime: IAgentRuntime,
  input: CreateTaskThreadInput,
): Promise<TaskAcceptanceCriteriaResult> {
  const provided = uniqueCriteria(input.acceptanceCriteria ?? []);
  if (provided.length > 0) {
    return {
      criteria: provided,
      source: "provided",
    };
  }

  try {
    const raw = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: buildAcceptancePrompt(input),
      temperature: 0.1,
      stream: false,
    });
    if (typeof raw === "string") {
      const parsed = parseCriteriaResponse(raw);
      if (parsed.length >= 3) {
        return {
          criteria: parsed,
          source: "model",
        };
      }
    }
  } catch {
    // Fall back to baseline criteria when the model is unavailable or invalid.
  }

  return {
    criteria: buildBaselineAcceptanceCriteria(input),
    source: "baseline",
  };
}
