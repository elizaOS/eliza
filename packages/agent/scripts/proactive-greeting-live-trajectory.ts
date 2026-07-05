/**
 * Live-model trajectory harness for the per-view proactive greeting (#13587).
 *
 * Drives the REAL judge path — declared anticipatory intent + rendered live view
 * state → `buildProactiveJudgePrompt` → a LIVE model → `parseProactiveJudge...`
 * — for a set of views, and prints the full prompt + raw model output + parsed
 * greeting for each. Knowledge/transcripts use the real `renderLiveStateForScope`
 * renderer over a stub documents store; wallet uses a representative rendered
 * wallet brief (its live state is fetched from the running local API in prod).
 *
 * Run: OPENAI_API_KEY=$CEREBRAS_API_KEY OPENAI_BASE_URL=https://api.cerebras.ai/v1 \
 *      bun packages/agent/scripts/proactive-greeting-live-trajectory.ts
 */
import type { IAgentRuntime, ViewSwitchedPayload } from "@elizaos/core";
import { renderLiveStateForScope } from "../src/providers/page-scoped-live-state.ts";
import {
  buildProactiveJudgePrompt,
  parseProactiveJudgeDecisionOutput,
} from "../src/services/proactive-interaction-decider.ts";

const BASE_URL =
  process.env.OPENAI_BASE_URL ||
  process.env.CEREBRAS_BASE_URL ||
  "https://api.cerebras.ai/v1";
const API_KEY = process.env.OPENAI_API_KEY || process.env.CEREBRAS_API_KEY;
const MODEL = process.env.LIVE_MODEL || "gpt-oss-120b";

if (!API_KEY) {
  console.error("No OPENAI_API_KEY / CEREBRAS_API_KEY set — cannot run live.");
  process.exit(1);
}

const now = Date.now();
function stubRuntime(documents: unknown[]): IAgentRuntime {
  return {
    agentId: "live-agent",
    reportError: (scope: string, err: unknown) =>
      console.error(`[reportError:${scope}]`, err),
    getMemories: async () => documents,
  } as unknown as IAgentRuntime;
}

async function callLiveModel(prompt: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    throw new Error(`live model ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

interface Case {
  label: string;
  payload: ViewSwitchedPayload;
  liveState: string | null;
}

async function buildCases(): Promise<Case[]> {
  const knowledgeRuntime = stubRuntime([
    {
      agentId: "live-agent",
      createdAt: now,
      metadata: { tags: ["attachment", "media-format:pdf"], addedAt: now },
    },
    {
      agentId: "live-agent",
      createdAt: now,
      metadata: { tags: ["attachment", "media-format:image"], addedAt: now },
    },
    {
      agentId: "live-agent",
      createdAt: now,
      metadata: { tags: ["transcript"], addedAt: now },
    },
  ]);
  const transcriptsRuntime = stubRuntime([
    {
      agentId: "live-agent",
      createdAt: now,
      metadata: { tags: ["transcript"], addedAt: now },
    },
    {
      agentId: "live-agent",
      createdAt: now,
      metadata: { tags: ["transcript"], addedAt: now },
    },
  ]);

  return [
    {
      label: "settings (intent, no live-state surface)",
      payload: {
        viewId: "settings",
        viewLabel: "Settings",
        initiatedBy: "user",
        anticipatoryIntent:
          "Offer to set up the model/provider, voice, or connectors — recommend the smallest concrete configuration step from current settings state.",
        viewPurpose: "Configuration, plugins, credentials, and preferences",
      } as ViewSwitchedPayload,
      liveState: null,
    },
    {
      label: "documents/knowledge (intent + real live-state renderer)",
      payload: {
        viewId: "documents",
        viewLabel: "Knowledge",
        initiatedBy: "user",
        anticipatoryIntent:
          "Offer to triage the newest ingested attachments/documents — summarize, tag, or file them — grounded in the recent-attachment counts.",
        viewPurpose:
          "Agent knowledge documents, uploads, and retrieval sources",
      } as ViewSwitchedPayload,
      liveState: await renderLiveStateForScope(
        knowledgeRuntime,
        "page-knowledge",
      ),
    },
    {
      label: "transcripts (intent + real live-state renderer)",
      payload: {
        viewId: "transcripts",
        viewLabel: "Transcripts",
        initiatedBy: "user",
        anticipatoryIntent:
          "Offer to summarize or extract action items from the most recent voice transcripts, grounded in the recent-transcript count.",
        viewPurpose: "Recorded voice transcripts — play, scrub, and read",
      } as ViewSwitchedPayload,
      liveState: await renderLiveStateForScope(
        transcriptsRuntime,
        "page-transcripts",
      ),
    },
    {
      label: "wallet (intent + representative live-state brief)",
      payload: {
        viewId: "wallet",
        viewLabel: "Wallet",
        initiatedBy: "user",
        anticipatoryIntent:
          "Offer a portfolio summary and a fund/swap next step, grounded in balances and readiness.",
        viewPurpose: "Token inventory, NFTs, LP positions, balance, and P&L",
      } as ViewSwitchedPayload,
      liveState: [
        "Live wallet state:",
        "- Wallet source: env",
        "- EVM address: 0x1234...abcd",
        "- Readiness: EVM balances ready, execution ready",
        "- Token inventory: 2 assets.",
        "  - 0.42 ETH",
        "  - 150.0 USDC",
        "- 24h activity: 3 swaps, realized P&L 0.05 BNB, volume 1.2 BNB.",
      ].join("\n"),
    },
    {
      label: "database (NO intent — must be allowed to stay silent)",
      payload: {
        viewId: "database",
        viewLabel: "Database",
        initiatedBy: "user",
      } as ViewSwitchedPayload,
      liveState: null,
    },
  ];
}

async function main() {
  const cases = await buildCases();
  for (const c of cases) {
    const hasIntent =
      typeof c.payload.anticipatoryIntent === "string" &&
      c.payload.anticipatoryIntent.trim().length > 0;
    const prompt = buildProactiveJudgePrompt(c.payload, c.liveState);
    console.log(`\n${"=".repeat(78)}`);
    console.log(`CASE: ${c.label}`);
    console.log("-".repeat(78));
    console.log(`PROMPT:\n${prompt}`);
    const raw = await callLiveModel(prompt);
    console.log("-".repeat(78));
    console.log(`RAW MODEL OUTPUT:\n${raw}`);
    const parsed = parseProactiveJudgeDecisionOutput(raw, {
      hasDeclaredIntent: hasIntent,
    });
    console.log("-".repeat(78));
    console.log(
      "PARSED GREETING: " +
        (parsed ? JSON.stringify(parsed) : "null (stayed silent)"),
    );
  }
  console.log(`\n${"=".repeat(78)}`);
  console.log("done");
}

void main();
