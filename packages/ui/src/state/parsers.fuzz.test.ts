// Fuzz / hardening pass for the untrusted-input parsers in state/parsers.ts.
// These decode raw WebSocket payloads and raw chat input, so the invariant is:
// never throw on arbitrary input, and either reject (null) or return a value
// that satisfies the parser's own type contract. A seeded LCG makes failures
// reproducible.

import { describe, expect, it } from "vitest";
import type { CustomActionDef } from "../api/client";
import {
  parseConversationMessageEvent,
  parseCustomActionParams,
  parseProactiveMessageEvent,
  parseSlashCommandInput,
  parseStreamEventEnvelopeEvent,
} from "./parsers";

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const KEYS = [
  "id",
  "role",
  "text",
  "timestamp",
  "type",
  "eventId",
  "ts",
  "payload",
  "conversationId",
  "message",
  "reactions",
  "emoji",
  "count",
  "__proto__",
];
const ROLE_VALS = ['"user"', '"assistant"', '"bot"', "5", "null"];
const TYPE_VALS = ['"agent_event"', '"heartbeat_event"', '"nope"', "1"];
const PRIMS = ["1", '"s"', "true", "false", "null", "-3.5", '"agent_event"'];

function randomJson(rng: () => number, depth: number): string {
  if (depth <= 0 || rng() < 0.45) {
    return PRIMS[Math.floor(rng() * PRIMS.length)];
  }
  const k = 1 + Math.floor(rng() * 4);
  if (rng() < 0.4) {
    return `[${Array.from({ length: k }, () => randomJson(rng, depth - 1)).join(",")}]`;
  }
  const entries: string[] = [];
  for (let i = 0; i < k; i++) {
    const key = KEYS[Math.floor(rng() * KEYS.length)];
    let value: string;
    if (key === "role") value = ROLE_VALS[Math.floor(rng() * ROLE_VALS.length)];
    else if (key === "type")
      value = TYPE_VALS[Math.floor(rng() * TYPE_VALS.length)];
    else value = randomJson(rng, depth - 1);
    entries.push(`${JSON.stringify(key)}:${value}`);
  }
  return `{${entries.join(",")}}`;
}

describe("WS event parsers — fuzz", () => {
  it("never throw and honor their type contracts on arbitrary payloads", () => {
    const rng = makeRng(0xabcdef);
    const ENVELOPE_TYPES = new Set([
      "agent_event",
      "heartbeat_event",
      "training_event",
    ]);
    for (let i = 0; i < 4000; i++) {
      const value = JSON.parse(randomJson(rng, 4));

      const msg = parseConversationMessageEvent(value);
      if (msg !== null) {
        expect(typeof msg.id).toBe("string");
        expect(msg.role === "user" || msg.role === "assistant").toBe(true);
        expect(typeof msg.text).toBe("string");
        expect(typeof msg.timestamp).toBe("number");
        for (const r of msg.reactions ?? []) {
          expect(typeof r.emoji).toBe("string");
          expect(r.emoji.length).toBeGreaterThan(0);
          expect(r.count).toBeGreaterThan(0);
        }
      }

      const env = parseStreamEventEnvelopeEvent(
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : {},
      );
      if (env !== null) {
        expect(ENVELOPE_TYPES.has(env.type)).toBe(true);
        expect(env.version).toBe(1);
        expect(typeof env.eventId).toBe("string");
        expect(typeof env.ts).toBe("number");
        expect(typeof env.payload).toBe("object");
      }

      const proactive = parseProactiveMessageEvent(
        value && typeof value === "object" && !Array.isArray(value)
          ? value
          : {},
      );
      if (proactive !== null) {
        expect(typeof proactive.conversationId).toBe("string");
        expect(typeof proactive.message.id).toBe("string");
      }
    }
  });
});

describe("chat-input parsers — fuzz", () => {
  const NASTY = String.fromCharCode(0, 0xffff, 0x200b);
  const TOKENS = [
    "/",
    "/cmd",
    " ",
    "  ",
    "=",
    'key="',
    '"',
    "'",
    "key=val",
    "to=",
    "\n",
    "\t",
    "wordy",
    NASTY,
  ];
  const action = {
    id: "a",
    name: "A",
    description: "",
    parameters: [
      { name: "to", description: "", required: true },
      { name: "input", description: "", required: false },
    ],
    enabled: true,
    createdAt: "",
    updatedAt: "",
  } as unknown as CustomActionDef;

  it("parseSlashCommandInput / parseCustomActionParams never throw and stay well-typed", () => {
    const rng = makeRng(0x5eed);
    for (let i = 0; i < 4000; i++) {
      const parts: string[] = [];
      const len = Math.floor(rng() * 10);
      for (let j = 0; j < len; j++) {
        parts.push(TOKENS[Math.floor(rng() * TOKENS.length)]);
      }
      const raw = parts.join("");

      const slash = parseSlashCommandInput(raw);
      if (slash !== null) {
        expect(slash.name.startsWith("/")).toBe(true);
        expect(typeof slash.argsRaw).toBe("string");
      }

      const { params, missingRequired } = parseCustomActionParams(action, raw);
      expect(typeof params).toBe("object");
      expect(Array.isArray(missingRequired)).toBe(true);
      for (const v of Object.values(params)) expect(typeof v).toBe("string");
    }
  });
});
