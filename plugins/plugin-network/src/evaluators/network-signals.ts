/**
 * NETWORK_SIGNALS: post-turn evaluator that records deterministic member
 * signals (opt-out wording, travel, safety concern) from the current message.
 * `resolveOutput` makes it model-free, so it adds no inference to the turn;
 * the PRD's LLM extraction evaluators would drop `resolveOutput` and use
 * `prompt` + `schema` instead.
 */
import type { Evaluator, EvaluatorProcessor } from "@elizaos/core";
import { ownWords } from "../routing/authz.js";
import type {
  NetworkSignal,
  NetworkStore,
  NetworkTurnAuthority,
} from "../types.js";

const PATTERNS: Array<{ kind: NetworkSignal["kind"]; re: RegExp }> = [
  {
    kind: "opt_out",
    re: /\b(stop texting|unsubscribe|leave (?:the )?network|remove me)\b/i,
  },
  {
    kind: "travel",
    // No `i` flag: the place must start with a capital letter, so "I'm in a
    // meeting" or "I will be in touch" is not travel.
    re: /\b(?:[Ii]'?m|[Ii] am|[Ww]ill be) (?:in|visiting|traveling to|flying to) ([A-Z][\w .'-]{1,40})/,
  },
  {
    kind: "safety_concern",
    re: /\b(made me uncomfortable|felt unsafe|harass\w*|creep(?:y|ed))\b/i,
  },
];

const NEGATED =
  /\b(?:not|never|don'?t|do not|didn'?t|won'?t|wasn'?t|isn'?t|no)\s+(?:\w+\s+)?$/i;

/**
 * Signals from the member's own words only (audit plugin-prototypes-8): quoted, reported and
 * forwarded text is removed first, and a negated match ("he wasn't creepy", "don't remove me")
 * is not a signal.
 */
export function detectNetworkSignals(text: string): NetworkSignal[] {
  const own = ownWords(text);
  const out: NetworkSignal[] = [];
  for (const { kind, re } of PATTERNS) {
    const m = re.exec(own);
    if (m && !NEGATED.test(own.slice(0, m.index)))
      out.push({ kind, evidence: m[0] });
  }
  return out;
}

interface Output {
  signals: NetworkSignal[];
}

export interface NetworkSignalsEvaluatorOptions {
  store: NetworkStore;
  authority: NetworkTurnAuthority;
}

export function createNetworkSignalsEvaluator(
  options: NetworkSignalsEvaluatorOptions,
): Evaluator<Output, { text: string }> {
  const recordProcessor: EvaluatorProcessor<Output, { text: string }> = {
    name: "recordNetworkSignals",
    async process({ output, message }) {
      if (output.signals.length === 0) return undefined;
      const { recorded } = await options.store.recordSignals({
        memberId: options.authority.memberId,
        messageId: String(message.id ?? ""),
        signals: output.signals,
      });
      return {
        success: true,
        values: { networkSignals: recorded },
        data: { actionName: "NETWORK_SIGNALS", recorded },
      };
    },
  };
  return {
    name: "NETWORK_SIGNALS",
    description:
      "Records opt-out, travel and safety signals for Network review.",
    inputScope: "current_message",
    schema: {
      type: "object",
      properties: {
        signals: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["opt_out", "travel", "safety_concern"],
              },
              evidence: { type: "string" },
            },
            required: ["kind", "evidence"],
          },
        },
      },
      required: ["signals"],
    },
    async shouldRun({ message }) {
      const text =
        typeof message.content?.text === "string" ? message.content.text : "";
      return detectNetworkSignals(text).length > 0;
    },
    async prepare({ message }) {
      return {
        text:
          typeof message.content?.text === "string" ? message.content.text : "",
      };
    },
    resolveOutput({ prepared }) {
      return { signals: detectNetworkSignals(prepared.text) };
    },
    prompt() {
      return "";
    },
    parse(output) {
      const o = output as Output | null;
      return o && Array.isArray(o.signals) ? o : null;
    },
    processors: [recordProcessor],
  };
}
