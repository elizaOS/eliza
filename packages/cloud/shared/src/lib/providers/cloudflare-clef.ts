/**
 * Clef decisions through the native Workers AI binding.
 *
 * Clef (`@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef`) takes a state and
 * typed questions and returns a probability per allowed answer; it writes no
 * text. This module turns the typed `@elizaos/cloud-sdk/clef-decisions`
 * requests into Clef questions and validates every answer at the provider
 * boundary. Request text is never logged.
 */
import {
  CLEF_ASK_THRESHOLD,
  CLEF_NO_CHOICE,
  CLEF_TURN_COMPLETE_THRESHOLD,
  type ClefDecisionRequest,
  type ClefDecisionResult,
} from "@elizaos/cloud-sdk/clef-decisions";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

export type ClefModel = "clef-flash" | "clef";

const CLEF_MODEL_IDS = {
  "clef-flash": "@cf/cloudflare/clef-flash",
  clef: "@cf/cloudflare/clef",
} as const;

type ClefQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

/** The Workers AI binding surface used here; responses are validated below. */
export interface CloudflareClefBinding {
  run(
    model: (typeof CLEF_MODEL_IDS)[ClefModel],
    input: { model: ClefModel; state: unknown; questions: Record<string, ClefQuestion> },
  ): Promise<unknown>;
}

export class ClefDecisionError extends ElizaError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, { code, cause });
  }
}

const probability = z.number().min(0).max(1);
const noulAnswer = z.object({ type: z.literal("noul"), noul: probability });
const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), probability),
  confidence: probability,
});
const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
});

/** `CLEF_DECISION_MODEL`: clef-flash (default, fast) or clef (larger, more exact). */
export function resolveClefModel(value: string | undefined): ClefModel {
  return value?.trim() === "clef" ? "clef" : "clef-flash";
}

/** The Clef state and questions for one typed request. */
export function buildClefInput(request: ClefDecisionRequest): {
  state: unknown;
  questions: Record<string, ClefQuestion>;
} {
  switch (request.kind) {
    case "choice": {
      const criteria: Record<string, string> = {};
      for (const candidate of request.candidates) criteria[candidate.id] = candidate.label;
      criteria[CLEF_NO_CHOICE] = "None of these controls fits the goal.";
      return {
        state: { goal: request.goal, page: request.page ?? "" },
        questions: {
          target: {
            type: "choice",
            instructions:
              "A person wants to reach the goal on this web page. Which control should they use next? Choose none if no control clearly fits.",
            criteria,
          },
        },
      };
    }
    case "mode":
      return {
        state: { action: request.action, context: request.context ?? "" },
        questions: {
          ask: {
            type: "noul",
            instructions:
              "Should an assistant stop and ask the person for a clear yes before doing this action? Yes if it pays, buys or donates money; enters a password, code or credential; sends or shares a message or personal data; changes an account or setting; deletes or cancels something; agrees, signs or consents; books, refills or schedules; or is otherwise hard to undo.",
            criteria: {
              true: "Stop and ask the person first.",
              false: "Safe to do while telling the person what is happening.",
            },
          },
        },
      };
    case "turn":
      return {
        state: {
          recentTurns: request.recentTurns ?? [],
          currentTurn: request.transcript,
        },
        questions: {
          complete: {
            type: "noul",
            instructions:
              "The person is speaking to an assistant. Has the person finished the current turn, so the assistant should answer now? No if the words trail off, stop mid-sentence or mid-number, or the person is clearly still thinking.",
            criteria: {
              true: "The person has finished and expects an answer.",
              false: "The person is still talking or has paused mid-thought.",
            },
          },
        },
      };
  }
}

/** Maps a validated Clef response to the typed result. */
export function parseClefOutput(request: ClefDecisionRequest, raw: unknown): ClefDecisionResult {
  const parsed = responseSchema.safeParse(raw);
  const invalid = () =>
    new ClefDecisionError("Clef returned an invalid decision", "CLEF_RESPONSE_INVALID");
  if (!parsed.success) throw invalid();
  const { model, answers } = parsed.data;
  switch (request.kind) {
    case "choice": {
      const answer = choiceAnswer.safeParse(answers.target);
      if (!answer.success) throw invalid();
      const allowed = new Set([...request.candidates.map((c) => c.id), CLEF_NO_CHOICE]);
      if (!allowed.has(answer.data.choice)) throw invalid();
      const probabilities: Record<string, number> = {};
      for (const id of allowed) probabilities[id] = answer.data.probabilities[id] ?? 0;
      return {
        status: "ok",
        kind: "choice",
        model,
        choice: answer.data.choice === CLEF_NO_CHOICE ? null : answer.data.choice,
        confidence: answer.data.confidence,
        probabilities,
      };
    }
    case "mode": {
      const answer = noulAnswer.safeParse(answers.ask);
      if (!answer.success) throw invalid();
      return {
        status: "ok",
        kind: "mode",
        model,
        suggestedMode: answer.data.noul >= CLEF_ASK_THRESHOLD ? "ask" : "tell",
        askProbability: answer.data.noul,
      };
    }
    case "turn": {
      const answer = noulAnswer.safeParse(answers.complete);
      if (!answer.success) throw invalid();
      return {
        status: "ok",
        kind: "turn",
        model,
        complete: answer.data.noul >= CLEF_TURN_COMPLETE_THRESHOLD,
        completeProbability: answer.data.noul,
      };
    }
  }
}

export async function runClefDecision(
  binding: CloudflareClefBinding,
  model: ClefModel,
  request: ClefDecisionRequest,
): Promise<ClefDecisionResult> {
  const input = buildClefInput(request);
  let raw: unknown;
  try {
    // AI.run has no documented abort parameter; Clef answers in milliseconds.
    raw = await binding.run(CLEF_MODEL_IDS[model], { model, ...input });
  } catch (cause) {
    // error-policy:J2 preserve the provider failure without its request text.
    throw new ClefDecisionError("Workers AI Clef request failed", "CLEF_PROVIDER_FAILED", cause);
  }
  return parseClefOutput(request, raw);
}
