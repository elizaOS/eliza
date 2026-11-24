/** Local measurement only (not committed): Stage 1 requests for synthetic long
 * conversations, with the whole history and with the phone's history window, for a
 * live model to answer. With CTX_WINDOW_ROUND1, replays the model's own first answers
 * through the runtime and records the request that follows a history read. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ChannelType, type Memory } from "@elizaos/core";
import { afterEach, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../__tests__/stage1/fixtures.ts";
import { historyRetentionEvaluator } from "../services/history-retention.ts";

const OUT = process.env.CTX_WINDOW_OUT;
/** Result files of the rounds already answered, in order (round 1 first). */
const CHAIN = (process.env.CTX_WINDOW_CHAIN ?? "").split(",").filter(Boolean);
const RUNS = Number(process.env.CTX_WINDOW_RUNS ?? 3);

type Case = {
  id: string;
  kind: "dependent" | "control" | "standing" | "recent" | "absent";
  /** The owner's line before an early reply by the agent. */
  ask?: string;
  /** Said near the start of the conversation, by the owner unless `byAgent`. */
  early?: string;
  byAgent?: boolean;
  /** Said three exchanges before the request. */
  recent?: string;
  request: string;
  /** Text a correct answer contains. */
  fact?: string;
};

const CASES: Case[] = [
  { id: "gate-code", kind: "dependent", early: "For future reference, my gate code is 4471#.", request: "What's my gate code again?", fact: "4471" },
  { id: "flight", kind: "dependent", early: "My sister Dana's flight is UA 328, landing Friday at 6:10pm.", request: "When does Dana's flight land?", fact: "6:10" },
  { id: "wifi", kind: "dependent", early: "The wifi password at the cabin is pinecone-42.", request: "What was the cabin wifi password?", fact: "pinecone-42" },
  { id: "booking", kind: "dependent", early: "I booked the table for 7:45 at Luca's.", byAgent: true, request: "What time did you book the table for?", fact: "7:45" },
  { id: "locker", kind: "dependent", early: "My locker number at the gym is 318.", request: "Remind me, what's my locker number?", fact: "318" },
  { id: "same-as-before", kind: "dependent", early: "Draft this for my landlord: The kitchen tap is dripping again, could someone look at it this week?", request: "Write out again, word for word, the note I asked you to draft for my landlord at the start of this chat.", fact: "dripping" },
  { id: "vet", kind: "dependent", early: "Milo's vet appointment is on the 14th, first thing in the morning.", request: "When is Milo's vet appointment?", fact: "14th" },
  { id: "allergy", kind: "dependent", early: "My nephew Theo is allergic to cashews.", request: "What is Theo allergic to?", fact: "cashew" },
  { id: "paint", kind: "dependent", early: "The paint colour we picked for the hallway is called Harbor Mist.", request: "What was the hallway paint colour called?", fact: "Harbor Mist" },
  { id: "dishwasher", kind: "dependent", byAgent: true, ask: "Which dishwasher should I buy?", early: "I'd go with the Bosch 500 series; it's the quietest in your budget.", request: "Which dishwasher did you recommend?", fact: "Bosch" },
  { id: "never-said", kind: "absent", request: "What's my passport number?" },
  { id: "thanks-earlier", kind: "control", request: "Thanks for the help earlier, that's everything." },
  { id: "recent-soup", kind: "recent", recent: "I think I'll make the lentil soup tonight.", request: "What did I say I'd cook tonight?", fact: "lentil" },
  { id: "standing-one-sentence", kind: "standing", early: "From now on, always end every reply to me with the word Noted.", request: "What's the capital of Portugal?", fact: "Noted" },
  { id: "arithmetic", kind: "control", request: "What's 18% of 240?", fact: "43.2" },
  { id: "synonym", kind: "control", request: "Give me one synonym for quick." },
  { id: "translate", kind: "control", request: "How do you say good morning in Spanish?", fact: "uenos" },
  { id: "thanks", kind: "control", request: "Thanks, that's all for now." },
  { id: "fun-fact", kind: "control", request: "Tell me one fun fact about octopuses." },
  { id: "recent-puppy", kind: "recent", recent: "I'm thinking of naming the puppy Biscuit.", request: "What name was I thinking of for the puppy?", fact: "Biscuit" },
  { id: "recent-time", kind: "recent", recent: "The plumber said he'd come at 2:30 tomorrow.", request: "What time is the plumber coming?", fact: "2:30" },
];

const CHATTER: [string, string][] = [
  ["How long should I boil an egg for a soft yolk?", "About six minutes from a rolling boil, then into cold water."],
  ["Is it going to be a good weekend for a hike?", "I can't see a forecast from here, but late morning starts usually avoid the worst heat."],
  ["Give me a two-line poem about coffee.", "Dark and warm, the morning's friend. One more cup before the end."],
  ["What's a polite way to decline a meeting?", "Thank them, say you can't make it, and offer to read the notes afterwards."],
  ["How many ounces are in a pound?", "Sixteen."],
  ["Suggest a name for a sourdough starter.", "Doughbi-Wan Kenobi."],
  ["What should I cook with leftover rice?", "Fried rice with an egg and whatever vegetables are in the fridge."],
  ["Is 7 hours of sleep enough?", "For most adults it's on the low end of the recommended range."],
  ["Recommend a board game for four.", "Ticket to Ride is easy to teach and plays well with four."],
];

function rows(testCase: Case, message: Memory, agentId: string): Memory[] {
  const out: Memory[] = [];
  const add = (fromAgent: boolean, text: string) =>
    out.push({
      ...message,
      id: `00000000-0000-0000-0000-${String(1000 + out.length).padStart(12, "0")}` as Memory["id"],
      createdAt: 1_795_000_000_000 + out.length * 30_000,
      entityId: (fromAgent ? agentId : message.entityId) as Memory["entityId"],
      content: { ...message.content, text },
    });
  add(false, "Hi, I have a few things to sort out today.");
  add(true, "Sure, go ahead.");
  if (testCase.early) {
    if (testCase.byAgent) {
      add(false, testCase.ask ?? "Please book a table for two tonight.");
      add(true, testCase.early);
    } else {
      add(false, testCase.early);
      add(true, "Got it.");
    }
  }
  for (let index = 0; index < 28; index++) {
    const [ask, answer] = CHATTER[index % CHATTER.length];
    if (testCase.recent && index === 25) {
      add(false, testCase.recent);
      add(true, "Okay.");
      continue;
    }
    add(false, ask);
    add(true, answer);
  }
  return out;
}

afterEach(() => vi.unstubAllEnvs());

type Call = { name: string; arguments: unknown };

it.skipIf(!OUT)(
  "writes Stage 1 requests for the history-window eval",
  async () => {
    // Per case, run and variant: the model's own calls in each earlier round.
    const answered = new Map<string, Call[][]>();
    CHAIN.forEach((file, round) => {
      if (!existsSync(file)) return;
      for (const line of readFileSync(file, "utf8").trim().split("\n")) {
        const record = JSON.parse(line);
        if (record.error) continue;
        const key =
          round === 0
            ? `${record.id}#${record.run}:${record.variant}`
            : `${record.id}:${record.variant}`;
        const rounds = answered.get(key) ?? [];
        if (rounds.length === round) answered.set(key, [...rounds, record.calls]);
      }
    });
    const lines: string[] = [];
    for (const testCase of CASES) {
      for (let run = 0; run < (CHAIN.length ? RUNS : 1); run++) {
        const variants: Record<string, unknown> = {};
        for (const [variant, platform] of [
          ["whole", ""],
          ["window", "android"],
        ] as const) {
          vi.stubEnv("ELIZA_PLATFORM", platform);
          const rounds = answered.get(`${testCase.id}#${run}:${variant}`) ?? [];
          // A later round exists only while every answer so far was a read.
          if (
            CHAIN.length &&
            (rounds.length !== CHAIN.length ||
              !rounds.every((calls) =>
                calls.some((call) => call.name === "READ_CONTEXT"),
              ))
          )
            continue;
          const scripted = [
            ...rounds.map((calls) => ({
              text: "",
              toolCalls: calls.map((call, index) => ({
                id: `call-${index}`,
                name: call.name,
                arguments: call.arguments,
              })),
            })),
            stage1Response({ contexts: ["simple"], replyText: "ok" }),
          ];
          const runtime = makeRuntime(scripted);
          Object.assign(runtime, { evaluators: [historyRetentionEvaluator] });
          runtime.getCache = async () => undefined;
          const message = makeMessage({
            channelType: ChannelType.DM,
            text: testCase.request,
          });
          message.createdAt = 1_795_000_000_000 + 100 * 30_000;
          const state = makeState();
          state.data.providers = {
            RECENT_MESSAGES: {
              data: {
                recentMessages: rows(testCase, message, String(runtime.agentId)),
              },
            },
          };
          runtime.composeState = vi.fn(async () => structuredClone(state));
          let failure: string | undefined;
          try {
            await runStage1({ runtime, message, state });
          } catch (error) {
            failure = String(error).slice(0, 300);
          }
          const calls = useModelCalls(runtime) as [
            string,
            Record<string, unknown>,
          ][];
          const sent = calls[rounds.length]?.[1];
          if (!sent) {
            variants[variant] = { error: failure ?? "no request" };
            continue;
          }
          const messages = sent.messages as {
            role?: string;
            content?: unknown;
          }[];
          const lead = messages[0]?.role === "system" ? messages[0] : undefined;
          variants[variant] = {
            system:
              typeof sent.system === "string"
                ? sent.system
                : String(lead?.content ?? ""),
            messages: lead ? messages.slice(1) : messages,
            tools: (sent.tools as Record<string, unknown>[]).map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            ...(failure ? { failure } : {}),
          };
        }
        if (!Object.keys(variants).length) continue;
        lines.push(
          JSON.stringify({
            id: CHAIN.length ? `${testCase.id}#${run}` : testCase.id,
            kind: testCase.kind,
            text: testCase.request,
            fact: testCase.fact ?? null,
            round: CHAIN.length + 1,
            variants,
          }),
        );
      }
    }
    writeFileSync(String(OUT), lines.length ? `${lines.join("\n")}\n` : "", {
      mode: 0o600,
    });
  },
  300_000,
);
