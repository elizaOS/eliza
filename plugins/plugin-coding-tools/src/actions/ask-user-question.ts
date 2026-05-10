import {
  type Action,
  type ActionResult,
  logger as coreLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";

import {
  failureToActionResult,
  readArrayParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS, CODING_TOOLS_LOG_PREFIX } from "../types.js";

export interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface Question {
  question: string;
  header: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 4;

function parseOption(
  raw: unknown,
  qIdx: number,
  oIdx: number,
): QuestionOption | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: `questions[${qIdx}].options[${oIdx}] must be an object` };
  }
  const obj = raw as Record<string, unknown>;
  const label = obj.label;
  if (typeof label !== "string" || label.length === 0) {
    return {
      error: `questions[${qIdx}].options[${oIdx}].label must be a non-empty string`,
    };
  }
  const out: QuestionOption = { label };
  if (typeof obj.description === "string") out.description = obj.description;
  if (typeof obj.preview === "string") out.preview = obj.preview;
  return out;
}

function parseQuestion(
  raw: unknown,
  idx: number,
): Question | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: `questions[${idx}] must be an object` };
  }
  const obj = raw as Record<string, unknown>;

  const question = obj.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return { error: `questions[${idx}].question must be a non-empty string` };
  }
  const header = obj.header;
  if (typeof header !== "string" || header.trim().length === 0) {
    return { error: `questions[${idx}].header must be a non-empty string` };
  }

  const out: Question = { question, header };

  if (obj.multiSelect !== undefined) {
    if (typeof obj.multiSelect !== "boolean") {
      return { error: `questions[${idx}].multiSelect must be a boolean` };
    }
    out.multiSelect = obj.multiSelect;
  }

  if (obj.options !== undefined) {
    if (!Array.isArray(obj.options)) {
      return {
        error: `questions[${idx}].options must be an array when provided`,
      };
    }
    if (obj.options.length > 0) {
      const opts: QuestionOption[] = [];
      for (let oIdx = 0; oIdx < obj.options.length; oIdx++) {
        const parsed = parseOption(obj.options[oIdx], idx, oIdx);
        if ("error" in parsed) return { error: parsed.error };
        opts.push(parsed);
      }
      out.options = opts;
    }
  }

  return out;
}

function renderQuestions(questions: readonly Question[]): string {
  return questions
    .map((q, idx) => {
      const lines: string[] = [`${idx + 1}. ${q.header}`, q.question];
      if (q.options && q.options.length > 0) {
        for (const opt of q.options) {
          const desc = opt.description ? ` — ${opt.description}` : "";
          lines.push(`   - ${opt.label}${desc}`);
        }
        if (q.multiSelect) lines.push("   (select one or more)");
      } else {
        lines.push("   (freeform answer)");
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

export const askUserQuestionAction: Action = {
  name: "ASK_USER_QUESTION",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: ["code", "terminal", "automation"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["ASK", "CLARIFY"],
  description:
    "Broadcast 1-4 structured questions back to the user. Each question has a short header, a full question string, and optional multi-choice options with descriptions and previews. This is a structured-question broadcast surface — the action returns the question payload as data so a UI layer can render it; the action does NOT block waiting for an answer. UI integration is pending; for now treat the response as a published question, not as an interactive prompt.",
  descriptionCompressed:
    "Broadcast 1-4 structured questions to the user (UI integration pending; non-blocking).",
  parameters: [
    {
      name: "questions",
      description:
        "Array of 1-4 question objects. Each: { question: string, header: string, options?: Array<{label, description?, preview?}>, multiSelect?: boolean }. If options is empty/undefined, the question is treated as freeform.",
      required: true,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            multiSelect: { type: "boolean" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                  preview: { type: "string" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "header"],
        },
      },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ) => {
    return true;
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const conversationId = message.roomId ? String(message.roomId) : undefined;
    if (!conversationId) {
      return failureToActionResult({
        reason: "missing_param",
        message: "missing roomId",
      });
    }

    const rawQuestions = readArrayParam(options, "questions");
    if (rawQuestions === undefined) {
      return failureToActionResult({
        reason: "missing_param",
        message: "questions is required and must be an array",
      });
    }
    if (
      rawQuestions.length < MIN_QUESTIONS ||
      rawQuestions.length > MAX_QUESTIONS
    ) {
      return failureToActionResult({
        reason: "invalid_param",
        message: `questions must contain ${MIN_QUESTIONS}-${MAX_QUESTIONS} items, got ${rawQuestions.length}`,
      });
    }

    const questions: Question[] = [];
    for (let i = 0; i < rawQuestions.length; i++) {
      const parsed = parseQuestion(rawQuestions[i], i);
      if ("error" in parsed) {
        return failureToActionResult({
          reason: "invalid_param",
          message: parsed.error,
        });
      }
      questions.push(parsed);
    }

    const text = renderQuestions(questions);
    coreLogger.debug(
      `${CODING_TOOLS_LOG_PREFIX} ASK_USER_QUESTION conversation=${conversationId} count=${questions.length}`,
    );

    if (callback) await callback({ text, source: "coding-tools" });

    return successActionResult(text, {
      questions,
      requiresUserInteraction: true,
    });
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Set up the deploy config.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Which environment should I deploy to (staging/production)?",
          actions: ["ASK_USER_QUESTION"],
          thought:
            "Required input is missing; ASK_USER_QUESTION pauses execution and surfaces a clarifying question to the user.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Migrate the schema.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Which database should I migrate against, and do you want a dry run first?",
          actions: ["ASK_USER_QUESTION"],
          thought:
            "Two ambiguities at once; bundle into a single ASK_USER_QUESTION rather than dispatching twice.",
        },
      },
    ],
  ],
};
