/**
 * Live-LLM evidence run for the MOVED inbox priority scorer
 * (plugins/plugin-inbox/src/inbox/priority-scoring.ts, #8652 port).
 *
 * Drives the REAL production scorer — real prompt builder, real batching,
 * real parser — against LIVE Cerebras (gpt-oss-120b). The only synthetic
 * piece is the IAgentRuntime.useModel bridge that forwards the scorer's
 * prompt to the Cerebras chat/completions API (the LLM boundary).
 *
 * Output: JSON trajectory {prompt, rawResponse, scores} on stdout.
 * The API key is read from the environment and never printed.
 */
import type { LifeOpsInboxMessage } from "@elizaos/shared";
import { scoreInboxMessages } from "../../../plugins/plugin-inbox/src/inbox/priority-scoring.ts";

const API_KEY = process.env.CEREBRAS_API_KEY;
if (!API_KEY) throw new Error("CEREBRAS_API_KEY is not set");
const MODEL = process.env.CEREBRAS_MODEL ?? "gpt-oss-120b";

const trajectory: {
  model: string;
  calls: Array<{ prompt: string; rawResponse: string }>;
} = { model: MODEL, calls: [] };

async function cerebras(prompt: string): Promise<string> {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`Cerebras ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content ?? "";
  trajectory.calls.push({ prompt, rawResponse: content });
  return content;
}

// Minimal LLM-boundary bridge: only the members the scorer touches.
const runtime = {
  agentId: "live-evidence-agent",
  character: { name: "Eliza" },
  useModel: async (_type: string, params: { prompt: string }) =>
    cerebras(params.prompt),
} as never;

function msg(
  id: string,
  channel: LifeOpsInboxMessage["channel"],
  from: string,
  snippet: string,
  subject: string | null = null,
): LifeOpsInboxMessage {
  const now = new Date().toISOString();
  return {
    id,
    channel,
    threadId: `thread-${id}`,
    chatType: "dm",
    sender: { id: `sender-${id}`, displayName: from, email: null },
    subject,
    snippet,
    receivedAt: now,
    timestamp: Date.now(),
    isRead: false,
    deepLink: null,
    sourceRef: {},
  } as LifeOpsInboxMessage;
}

const messages = [
  msg(
    "m1",
    "gmail",
    "Acme Billing",
    "Invoice #4482 is 10 days overdue — service suspension on Friday unless paid.",
    "OVERDUE: Invoice #4482",
  ),
  msg(
    "m2",
    "discord",
    "gamer_pal",
    "yo did you see the new patch notes lol",
  ),
  msg(
    "m3",
    "gmail",
    "Dr. Chen's office",
    "Reminder: your appointment is Tuesday at 9am. Reply C to confirm.",
    "Appointment reminder",
  ),
  msg(
    "m4",
    "telegram",
    "Mom",
    "Call me when you can, nothing urgent, just want to plan Sunday dinner.",
  ),
];

const scores = await scoreInboxMessages(runtime, messages, {
  ownerName: "Shaw",
});

console.log(
  JSON.stringify(
    {
      model: MODEL,
      messages: messages.map((m) => ({
        id: m.id,
        channel: m.channel,
        from: m.sender.displayName,
        snippet: m.snippet,
      })),
      scores,
      trajectory,
    },
    null,
    2,
  ),
);
