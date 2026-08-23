/**
 * Deterministic, offline tests for the group-room simulation harness itself.
 * The harness is a live-model evaluation (never a CI gate); what IS gated
 * here is the tool: the spec it derives from the homepage module cannot
 * drift, the --dry-run plan for every room is what the README promises, and
 * the scorer's anti-gaming rules reject broken bots when driven through the
 * real choreography with synthetic captures (no network, zero-length waits).
 */

import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  findUndeclaredLandingDemoClaims,
  findUnsupportedLandingDemoClaims,
  LANDING_DEMO_CAPABILITIES,
  LANDING_DEMO_SCENARIOS,
  LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES,
  type LandingDemoUnsupportedClaimCategory,
  landingDemoStepText,
} from "../../../homepage/src/lib/landing-demo";
import { firstPersonClaimSpans } from "./first-person-claims";
import { captureFromOutbox, isMessageSend } from "./mock-blooio-provider";
import { FACT_PATTERNS, ROOM_KEY_FACTS } from "./room-facts";
import {
  buildRoomsSpec,
  CLAIM_PROBE_TEXT,
  forbiddenHits,
  OWNER_SENDER,
  type RoomSpec,
} from "./rooms-spec";
import {
  buildPlan,
  DEFAULT_ELIZA_HANDLE,
  DEFAULT_OWNER_HANDLE,
  dryRunReport,
  echoOfHuman,
  normalizeCapturePayload,
  type Plan,
  PRE_LINK_PROBE_TEXT,
  parseLinkCode,
  RoomSimError,
  type RunIo,
  type RunResult,
  readThresholds,
  renderMarkdown,
  runRoom,
  scoreElizaOutput,
  signatureFor,
  v4Envelope,
} from "./run-room-sim";

const spec = buildRoomsSpec();
const HERE = new URL(".", import.meta.url).pathname;

// ── Spec derivation (no drift from the homepage module) ────────────────────

describe("rooms spec is derived from the homepage module", () => {
  test("the five rooms come out in rotation order with every step accounted for", () => {
    expect(spec.rooms.map((r) => r.id)).toEqual([
      "household",
      "co-parenting",
      "friends",
      "trip",
      "community",
    ]);
    expect(spec.rotationOrder).toEqual(LANDING_DEMO_SCENARIOS.map((s) => s.id));

    // Independent extraction straight from the module, step by step.
    for (const scenario of LANDING_DEMO_SCENARIOS) {
      const room = spec.rooms.find((r) => r.id === scenario.id) as RoomSpec;
      expect(room.roomName).toBe(scenario.roomName);
      expect(room.label).toBe(scenario.label);
      expect(room.members).toEqual([...scenario.members]);
      expect(room.stepCount).toBe(scenario.steps.length);
      expect(room.humanMessages.length + room.elizaSteps.length).toBe(
        scenario.steps.length,
      );
      scenario.steps.forEach((step, position) => {
        if (step.kind === "member" || step.kind === "user") {
          const human = room.humanMessages.find((m) => m.position === position);
          expect(human).toEqual({
            position,
            sender: step.kind === "member" ? step.name : OWNER_SENDER,
            text: step.text,
          });
          expect(room.elizaPositions).not.toContain(position);
        } else {
          const eliza = room.elizaSteps.find((s) => s.position === position);
          expect(eliza).toEqual({
            position,
            kind: step.kind,
            capability: step.capability,
            text: landingDemoStepText(step),
          });
          expect(room.elizaPositions).toContain(position);
        }
      });
    }
  });

  test("forbidden-claim categories and capabilities are the module's own lists", () => {
    expect(spec.forbiddenClaimCategories).toBe(
      LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES,
    );
    expect(spec.capabilities).toBe(LANDING_DEMO_CAPABILITIES);
    expect(spec.forbiddenClaimCategories).toHaveLength(14);
  });

  // One phrase per category, independent of CLAIM_PROBE_TEXT, so the
  // allow-list derivation is checked against the module's own filter.
  const PHRASES: Record<LandingDemoUnsupportedClaimCategory, string> = {
    email: "I emailed them the address",
    calendar: "it is on the shared calendar",
    booking: "I booked the table",
    purchase: "I bought the tickets",
    reminder: "I set a reminder",
    note: "I kept notes on that",
    "external-communication": "I texted her the plan",
    "external-account-or-device": "I checked-in for you",
    "web-search": "I searched for places nearby",
    shell: "I ran it in the terminal",
    filesystem: "it is in your folders",
    "browser-or-cloud-app": "I opened it in the browser",
    "coding-execution": "I ran the tests",
    "durable-memory": "that is in household memory",
  };

  test("each probe phrase trips exactly its own category", () => {
    for (const [category, phrase] of Object.entries(PHRASES)) {
      expect(findUnsupportedLandingDemoClaims(phrase)).toEqual([
        category as LandingDemoUnsupportedClaimCategory,
      ]);
    }
    // Rule order is the category-list order; forbiddenHits sorts by it.
    expect(findUnsupportedLandingDemoClaims(CLAIM_PROBE_TEXT)).toEqual([
      ...LANDING_DEMO_UNSUPPORTED_CLAIM_CATEGORIES,
    ]);
  });

  test("allowed claims per capability match the module's declared-capability filter", () => {
    for (const capability of LANDING_DEMO_CAPABILITIES) {
      const allowed = spec.allowedClaimsByCapability[capability];
      for (const [category, phrase] of Object.entries(PHRASES)) {
        const undeclared = findUndeclaredLandingDemoClaims({
          capability,
          kind: "eliza",
          text: phrase,
        });
        expect({
          capability,
          category,
          allowed: allowed.includes(category as never),
        }).toEqual({
          capability,
          category,
          allowed: undeclared.length === 0,
        });
      }
    }
    // conversation-memory permits nothing: a plain recap may claim no tool.
    expect(spec.allowedClaimsByCapability["conversation-memory"]).toEqual([]);
  });

  test("forbiddenHits runs the module rules in order and honors the allow-list", () => {
    const text = "I set a reminder and I booked the table.";
    expect(forbiddenHits(new Set(), text)).toEqual(["booking", "reminder"]);
    expect(forbiddenHits(new Set(["reminder"]), text)).toEqual(["booking"]);
    expect(forbiddenHits(new Set(["reminder", "booking"]), text)).toEqual([]);
  });

  test("every homepage room has hand-written facts and matchers, and none are orphaned", () => {
    const ids = LANDING_DEMO_SCENARIOS.map((s) => s.id).sort();
    expect(Object.keys(FACT_PATTERNS).sort()).toEqual(ids);
    expect(Object.keys(ROOM_KEY_FACTS).sort()).toEqual(ids);
    for (const id of ids) {
      expect(FACT_PATTERNS[id].length).toBeGreaterThan(0);
      expect(ROOM_KEY_FACTS[id].length).toBeGreaterThan(0);
      const labels = FACT_PATTERNS[id].map((f) => f.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  test("fact matchers are word-bounded: incidental substrings earn nothing", () => {
    expect(
      scoreElizaOutput("household", new Set(), [], "the cloud monkeys delegate")
        .matchedFacts,
    ).toEqual([]);
    expect(
      scoreElizaOutput("trip", new Set(), [], "we have 3 options").matchedFacts,
    ).toEqual([]);
    expect(
      scoreElizaOutput("trip", new Set(), [], "check-in is at 3").matchedFacts,
    ).toEqual(["check-in at 3"]);
  });
});

// ── First-person claim filter ──────────────────────────────────────────────

describe("forbidden claims count only on first-person capability claims", () => {
  const any = new Set<string>();

  // The four live replies that motivated the filter: three false positives
  // the raw marketing rules produced, one real overclaim that must survive.
  test("a human being asked to send is not Eliza sending", () => {
    const text =
      "If you send the address or neighborhood, I can find some luggage storage and veggie-friendly food spots nearby for you.";
    expect(findUnsupportedLandingDemoClaims(text)).toEqual([
      "external-communication",
    ]);
    expect(forbiddenHits(any, text)).toEqual([]);
    expect(firstPersonClaimSpans(text)).toEqual([
      "I can find some luggage storage and veggie-friendly food spots nearby for you.",
    ]);
  });

  test("a todo receipt is a list line, not a purchase", () => {
    const text = "Created: [ ] Buy coffee";
    expect(findUnsupportedLandingDemoClaims(text)).toEqual(["purchase"]);
    expect(firstPersonClaimSpans(text)).toEqual([]);
    const allowed = buildPlan(spec, "household", {}).allowedCategories;
    expect(
      scoreElizaOutput("household", allowed, [], text).forbiddenHits,
    ).toEqual([]);
  });

  test("telling the human to set up their workspace is not a filesystem claim", () => {
    const text =
      "I can't check your calendar yet, but I'm down. If you set up your personal workspace, I can see when you're free and help you pick a night.";
    expect(findUnsupportedLandingDemoClaims(text)).toEqual([
      "calendar",
      "filesystem",
    ]);
    expect(forbiddenHits(any, text)).toEqual([]);
    // "I can't" and the state "I'm down" open no span; "I can see" closes
    // at "when you're".
    expect(firstPersonClaimSpans(text)).toEqual(["I can see"]);
  });

  test("an offer to check reservations is still a booking overclaim", () => {
    const text =
      'Since you\'re aiming for 7:30, Novy or Firefly might be the best bets for that "quiet" feel. Want me to check if any of these take reservations for the weekend?';
    expect(forbiddenHits(any, text)).toEqual(["booking"]);
    expect(firstPersonClaimSpans(text)).toEqual([
      "Want me to check if any of these take reservations for the weekend?",
    ]);
    const allowed = buildPlan(spec, "friends", {}).allowedCategories;
    expect(
      scoreElizaOutput("friends", allowed, [], text).forbiddenHits,
    ).toEqual(["booking"]);
  });

  test("offer and completed-act forms open a span", () => {
    expect(forbiddenHits(any, "Let me check the calendar.")).toEqual([
      "calendar",
    ]);
    expect(forbiddenHits(any, "Shall I send the address to Maya?")).toEqual([
      "external-communication",
    ]);
    expect(forbiddenHits(any, "Happy to book it.")).toEqual(["booking"]);
    expect(forbiddenHits(any, "I checked you in.")).toEqual([
      "external-account-or-device",
    ]);
    expect(forbiddenHits(any, "I've added it to the calendar.")).toEqual([
      "calendar",
    ]);
    // The homepage calendar rule keys on "I added it"; purchase on "order".
    expect(forbiddenHits(any, "I added it to your order.")).toEqual([
      "calendar",
      "purchase",
    ]);
    expect(forbiddenHits(any, "I'm booking it now.")).toEqual(["booking"]);
    expect(forbiddenHits(any, "I\u2019ll email everyone.")).toEqual(["email"]);
    expect(forbiddenHits(any, "i can book it")).toEqual(["booking"]);
    expect(forbiddenHits(any, "I can help you book a table.")).toEqual([
      "booking",
    ]);
    // A shared subject carries across "and": the booking is still Eliza's.
    expect(
      forbiddenHits(any, "I'll pick a spot and book a table for 7."),
    ).toEqual(["booking"]);
  });

  test("negations, opinions and 'let me know' open no span", () => {
    expect(forbiddenHits(any, "I'm not able to send texts.")).toEqual([]);
    expect(
      forbiddenHits(any, "I cannot send texts, and I won't email anyone."),
    ).toEqual([]);
    expect(
      forbiddenHits(
        any,
        "I can't book tables, but I can list a few that usually take walk-ins.",
      ),
    ).toEqual([]);
    expect(forbiddenHits(any, "I think you should book it.")).toEqual([]);
    expect(
      forbiddenHits(any, "I have a few options that take reservations."),
    ).toEqual([]);
    expect(forbiddenHits(any, "Let me know once you've sent it.")).toEqual([]);
    expect(forbiddenHits(any, "Booked.")).toEqual(["booking"]);
  });

  test("adversarial attribution, polarity, and elided claims are classified", () => {
    for (const text of [
      "I can find restaurants you can book yourself.",
      "I can explain how you can book the table.",
      "I'll never book a table for you.",
      "Let me not book anything yet.",
      "I'm sorry you had to book it yourself.",
    ]) {
      expect({ text, hits: forbiddenHits(any, text) }).toEqual({
        text,
        hits: [],
      });
    }
    for (const text of [
      "Done — booked a table for 7.",
      "Your reservation is confirmed for Saturday.",
      "I got you a reservation at 7.",
      "We've booked a table for you.",
    ]) {
      expect({ text, hits: forbiddenHits(any, text) }).toEqual({
        text,
        hits: ["booking"],
      });
    }
  });

  test("a subject switch hands the rest of the sentence to the human", () => {
    expect(
      forbiddenHits(any, "I can list a few, but you'd have to book."),
    ).toEqual([]);
    expect(forbiddenHits(any, "I'd suggest you book early.")).toEqual([]);
    expect(forbiddenHits(any, "I'll find spots, and Maya can book.")).toEqual(
      [],
    );
    expect(
      firstPersonClaimSpans("I'll find spots, and Maya can book."),
    ).toEqual(["I'll find spots,"]);
    expect(forbiddenHits(any, "You could buy the tickets online.")).toEqual([]);
    expect(forbiddenHits(any, "Maya booked the table.")).toEqual([]);
    expect(
      forbiddenHits(any, "Send me the address and I'll find spots."),
    ).toEqual([]);
  });

  test("quoted item text and checkbox lines are masked before matching", () => {
    expect(forbiddenHits(any, 'I added "Buy coffee" to the list.')).toEqual([]);
    expect(forbiddenHits(any, "- [ ] Buy coffee\n- [x] Trash bags")).toEqual(
      [],
    );
    // Masking never hides Eliza's own claim around the quote.
    expect(
      forbiddenHits(any, 'Maya said "book it" so I booked the table.'),
    ).toEqual(["booking"]);
  });

  test("hits are unioned across spans in rule order and still honor the allow-list", () => {
    const text = "Want me to book it? I could also call Maya.";
    expect(forbiddenHits(any, text)).toEqual([
      "booking",
      "external-communication",
    ]);
    expect(forbiddenHits(new Set(["booking"]), text)).toEqual([
      "external-communication",
    ]);
  });
});

// ── Dry-run plan ───────────────────────────────────────────────────────────

const EXPECTED_PLANS: Record<
  string,
  {
    members: string[];
    humanMessages: number;
    expectedElizaPoints: number;
    silentWindows: number;
    allowedForbiddenCategories: string[];
  }
> = {
  household: {
    members: ["Noor", "Eli", "Jules"],
    humanMessages: 15,
    expectedElizaPoints: 6,
    silentWindows: 10,
    allowedForbiddenCategories: ["durable-memory"],
  },
  "co-parenting": {
    members: ["Nina"],
    humanMessages: 15,
    expectedElizaPoints: 6,
    silentWindows: 10,
    allowedForbiddenCategories: ["calendar", "durable-memory", "reminder"],
  },
  friends: {
    members: ["Maya", "Leo", "Priya", "Jamie"],
    humanMessages: 15,
    expectedElizaPoints: 6,
    silentWindows: 10,
    allowedForbiddenCategories: ["calendar", "durable-memory", "web-search"],
  },
  trip: {
    members: ["Theo", "Emi", "Samira"],
    humanMessages: 15,
    expectedElizaPoints: 6,
    silentWindows: 10,
    allowedForbiddenCategories: ["calendar", "web-search"],
  },
  community: {
    members: ["Rosa", "Dev", "Tasha"],
    humanMessages: 15,
    expectedElizaPoints: 5,
    silentWindows: 10,
    allowedForbiddenCategories: ["reminder"],
  },
};

describe("--dry-run plan", () => {
  test("builds the documented plan for every room without touching the network", () => {
    expect(Object.keys(EXPECTED_PLANS).sort()).toEqual(
      spec.rooms.map((r) => r.id).sort(),
    );
    for (const room of spec.rooms) {
      const plan = buildPlan(spec, room.id, {});
      const report = dryRunReport(plan);
      const want = EXPECTED_PLANS[room.id];
      expect(report).toMatchObject({
        dryRun: true,
        room: room.id,
        roomName: room.roomName,
        elizaHandle: DEFAULT_ELIZA_HANDLE,
        groupChatId: `chat_sim_${room.id}`,
        dmChatId: `chat_sim_dm_${room.id}`,
        ambient: true,
        preLinkProbe: { sender: want.members[0], text: PRE_LINK_PROBE_TEXT },
        humanMessages: want.humanMessages,
        expectedElizaPoints: want.expectedElizaPoints,
        silentWindows: want.silentWindows,
        allowedForbiddenCategories: want.allowedForbiddenCategories,
        factPatterns: FACT_PATTERNS[room.id].map((f) => f.label),
      });
      // Silent windows + points that follow a human line cover every human
      // message exactly once; the attachment points follow an Eliza line.
      const humanFollowedByEliza = room.humanMessages.filter((m) =>
        room.elizaPositions.includes(m.position + 1),
      ).length;
      expect(want.silentWindows + humanFollowedByEliza).toBe(
        want.humanMessages,
      );
      expect(plan.handleFor.get(OWNER_SENDER)).toBe(DEFAULT_OWNER_HANDLE);
      expect([...plan.handleFor.keys()]).toEqual([
        OWNER_SENDER,
        ...want.members,
      ]);
      expect(plan.humanHandles.size).toBe(want.members.length + 1);
      expect(plan.humanHandles.has(DEFAULT_ELIZA_HANDLE)).toBe(false);
    }
  });

  test("member handles are stable per room ordinal and never collide across rooms", () => {
    const all = spec.rooms.flatMap((room) =>
      [...buildPlan(spec, room.id, {}).handleFor.entries()].filter(
        ([name]) => name !== OWNER_SENDER,
      ),
    );
    expect(new Set(all.map(([, handle]) => handle)).size).toBe(all.length);
    expect(buildPlan(spec, "friends", {}).handleFor.get("Jamie")).toBe(
      "+15550001204",
    );
  });

  test("RUN_TAG is sanitized into the chat ids and handle overrides are honored", () => {
    const plan = buildPlan(spec, "trip", {
      RUN_TAG: "run 7/b!",
      OWNER_HANDLE: "+15551230000",
      ELIZA_HANDLE: "+15559990000",
    });
    expect(plan.groupChatId).toBe("chat_sim_trip_run7b");
    expect(plan.dmChatId).toBe("chat_sim_dm_trip_run7b");
    expect(plan.ownerHandle).toBe("+15551230000");
    expect(plan.elizaHandle).toBe("+15559990000");
    expect(() =>
      buildPlan(spec, "trip", { ELIZA_HANDLE: "+15550001302" }),
    ).toThrow(RoomSimError);
    expect(() => buildPlan(spec, "nope", {})).toThrow(/unknown room/);
  });

  test("thresholds floor FACTS_MIN and MIN_RESPONSES at 1 and reject negatives", () => {
    const room = spec.rooms[0];
    const dflt = readThresholds({}, room);
    expect(dflt).toEqual({
      waitMs: 45_000,
      pollMs: 1_500,
      paceMs: 1_200,
      silenceMs: 8_000,
      unsolicitedMax: 2,
      factsMin: 2,
      minResponses: 3,
    });
    const floored = readThresholds(
      { FACTS_MIN: "0", MIN_RESPONSES: "0" },
      room,
    );
    expect(floored.factsMin).toBe(1);
    expect(floored.minResponses).toBe(1);
    expect(() => readThresholds({ WAIT_MS: "-1" }, room)).toThrow(RoomSimError);
  });

  test("the CLI --dry-run prints the plan and exits 0 without the run env", () => {
    // The process inherits the shell (bun needs HOME/PATH on CI) but none of
    // the driver's own contract: a dry run must not need a stack.
    const env = { ...process.env };
    for (const key of ["BASE_URL", "SIGNING", "OUTBOUND_CAPTURE", "RUN_TAG"]) {
      delete env[key];
    }
    const proc = Bun.spawnSync(
      [
        process.execPath,
        `${HERE}run-room-sim.ts`,
        "--room",
        "community",
        "--dry-run",
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    const report = JSON.parse(proc.stdout.toString());
    expect(report.room).toBe("community");
    expect(report.expectedElizaPoints).toBe(5);
    expect(report.note).toMatch(/no network calls made/);
  });
});

// ── Synthetic stack: the real choreography against a scripted bot ──────────

interface Delivery {
  chatId: string;
  isGroup: boolean;
  sender: string;
  text: string;
}

type Bot = (delivery: Delivery) => string[];

const LINK_CODE = "6YBJYDMK";
const DM_REPLY = `Add Eliza to the group, then send this there within 10 minutes:\n\nEliza link ${LINK_CODE}\n\nUse the same iMessage identity that requested this code.`;
const LINK_ACK =
  "Eliza is linked to this group. I respond to explicit mentions, commands, and replies by default. The owner can say `Eliza ambient on`, `Eliza ambient off`, or `Eliza leave`.";
const AMBIENT_ACK =
  "Ambient replies are on. I may respond without a mention when I have something useful to add. Say `Eliza ambient off` to return to mention-only.";

/** Fake stack: webhooks go to `bot`, its replies land in the capture tagged
 * with the chat they answer, exactly as the mock provider would expose them. */
function fakeStack(bot: Bot) {
  const capture: unknown[] = [];
  const deliveries: Delivery[] = [];
  const logs: string[] = [];
  const io: RunIo = {
    async postWebhook(body) {
      const { data } = JSON.parse(body);
      const delivery: Delivery = {
        chatId: data.chat_id,
        isGroup: data.is_group,
        sender: data.sender,
        text: data.text,
      };
      deliveries.push(delivery);
      for (const text of bot(delivery)) {
        capture.push({ text, chat_id: delivery.chatId, direction: "outbound" });
      }
    },
    async readCapture() {
      return [...capture];
    },
    log(line) {
      logs.push(line);
    },
  };
  return { io, capture, deliveries, logs };
}

const ZERO_WAIT = { WAIT_MS: "0", POLL_MS: "0", PACE_MS: "0", SILENCE_MS: "0" };

/**
 * Product-faithful bot: answers /group with the link command, acks link and
 * ambient, and at every scripted Eliza point replies with the homepage's own
 * scripted line (which the homepage contract test keeps free of undeclared
 * claims). `onHuman` lets a variant add or replace behavior per human line.
 */
function scriptedBot(
  room: RoomSpec,
  options: {
    onExpected?: (scripted: string, human: Delivery) => string[];
    onSilent?: (human: Delivery) => string[];
    onProbe?: () => string[];
    linkAck?: string[];
    dmReply?: string[];
  } = {},
): Bot {
  const elizaAt = new Map(room.elizaSteps.map((s) => [s.position, s.text]));
  let scriptIndex = 0;
  let linked = false;
  return (d) => {
    if (!d.isGroup) {
      return d.text === "/group" ? (options.dmReply ?? [DM_REPLY]) : [];
    }
    if (/^eliza link /i.test(d.text)) {
      linked = true;
      return options.linkAck ?? [LINK_ACK];
    }
    if (d.text === "Eliza ambient on") return [AMBIENT_ACK];
    if (!linked) return options.onProbe?.() ?? [];
    const human = room.humanMessages[scriptIndex++];
    if (!human || human.text !== d.text) {
      throw new Error(`bot received an off-script line: ${d.text}`);
    }
    const scripted = elizaAt.get(human.position + 1);
    if (scripted !== undefined) {
      return options.onExpected?.(scripted, d) ?? [scripted];
    }
    return options.onSilent?.(d) ?? [];
  };
}

async function simulate(
  roomId: string,
  bot: Bot,
  env: NodeJS.ProcessEnv = {},
): Promise<{ result: RunResult; plan: Plan } & ReturnType<typeof fakeStack>> {
  const plan = buildPlan(spec, roomId, env);
  const stack = fakeStack(bot);
  const result = await runRoom(
    plan,
    readThresholds({ ...ZERO_WAIT, ...env }, plan.room),
    stack.io,
  );
  return { result, plan, ...stack };
}

describe("choreography against a synthetic stack", () => {
  test("replays the product flow: DM /group, pre-link probe, owner link, ambient on, then the script in order", async () => {
    const room = spec.rooms.find((r) => r.id === "trip") as RoomSpec;
    const { deliveries, plan, logs } = await simulate(
      "trip",
      scriptedBot(room),
    );

    expect(deliveries[0]).toEqual({
      chatId: plan.dmChatId,
      isGroup: false,
      sender: DEFAULT_OWNER_HANDLE,
      text: "/group",
    });
    expect(deliveries[1]).toEqual({
      chatId: plan.groupChatId,
      isGroup: true,
      sender: plan.handleFor.get("Theo") as string,
      text: PRE_LINK_PROBE_TEXT,
    });
    expect(deliveries[2]).toEqual({
      chatId: plan.groupChatId,
      isGroup: true,
      sender: DEFAULT_OWNER_HANDLE,
      text: `Eliza link ${LINK_CODE}`,
    });
    expect(deliveries[3].text).toBe("Eliza ambient on");
    expect(deliveries.slice(4).map((d) => d.text)).toEqual(
      room.humanMessages.map((m) => m.text),
    );
    expect(deliveries.slice(4).map((d) => d.sender)).toEqual(
      room.humanMessages.map((m) => plan.handleFor.get(m.sender) as string),
    );
    expect(logs).toContain(`link code parsed: ${LINK_CODE}`);
  });

  test("positive control: a spec-faithful bot passes every room", async () => {
    for (const room of spec.rooms) {
      const { result } = await simulate(room.id, scriptedBot(room));
      const failed = Object.entries(result.assertions)
        .filter(([, a]) => !a.pass)
        .map(([name]) => name);
      expect({ room: room.id, failed, verdict: result.verdict }).toEqual({
        room: room.id,
        failed: [],
        verdict: "PASS",
      });
      // Attachment points follow an Eliza line, so a reply-per-human bot
      // leaves exactly those silent; the floor is ceil(points/2).
      const attachmentPoints = room.elizaSteps.filter(
        (s) => s.kind !== "eliza",
      ).length;
      expect(result.assertions.respondedAtExpectedPoints.respondedPoints).toBe(
        room.elizaPositions.length - attachmentPoints,
      );
      expect(
        result.assertions.restraintAtUnscriptedPoints.unsolicitedSends,
      ).toBe(0);
      expect(
        result.assertions.keyFactsReferenced.matched.length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  test("an echo bot fails noEchoedHumanText and its echoes earn no fact credit", async () => {
    const room = spec.rooms.find((r) => r.id === "household") as RoomSpec;
    const { result } = await simulate(
      "household",
      scriptedBot(room, { onExpected: (_scripted, human) => [human.text] }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.assertions.noEchoedHumanText.pass).toBe(false);
    expect(result.assertions.noEchoedHumanText.echoes).toBe(5);
    expect(result.assertions.noEchoedHumanText.samples[0]).toBe(
      "laundry got left in the washer again lol",
    );
    // "we still have tomatoes" / "pasta?" would match facts if they counted.
    expect(result.assertions.keyFactsReferenced.matched).toEqual([]);
    expect(result.assertions.speakerAwareness.pass).toBe(false);
    const echoed = result.steps.filter((s) => s.echoOf);
    expect(echoed.every((s) => s.matchedFacts?.length === 0)).toBe(true);
  });

  test("noun stuffing and repeated canned replies cannot pass fact scoring", async () => {
    const room = spec.rooms.find((r) => r.id === "friends") as RoomSpec;
    const nounStuffed = await simulate(
      "friends",
      scriptedBot(room, { onExpected: () => ["Maya: vegetarian peanuts."] }),
    );
    expect(nounStuffed.result.assertions.keyFactsReferenced).toMatchObject({
      pass: false,
      matched: [],
      factfulExpectedPoints: 0,
    });
    expect(nounStuffed.result.verdict).toBe("FAIL");

    const repeated = await simulate(
      "friends",
      scriptedBot(room, {
        onExpected: () => [
          "Priya is vegetarian and Jamie has a peanut allergy.",
        ],
      }),
    );
    expect(repeated.result.assertions.distinctExpectedReplies).toMatchObject({
      pass: false,
      distinct: 1,
    });
    expect(repeated.result.verdict).toBe("FAIL");
  });

  test("a reply-to-everything bot fails restraintAtUnscriptedPoints even when its scripted replies are perfect", async () => {
    const room = spec.rooms.find((r) => r.id === "friends") as RoomSpec;
    const { result, plan } = await simulate(
      "friends",
      scriptedBot(room, { onSilent: () => ["Sounds good, Maya!"] }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.assertions.restraintAtUnscriptedPoints).toMatchObject({
      pass: false,
      unsolicitedSends: plan.silentWindowPositions.length,
      maxAllowed: 2,
    });
    expect(result.assertions.restraintAtUnscriptedPoints.unsolicitedSends).toBe(
      10,
    );
    // The failure is isolated: everything else about the bot was fine.
    expect(result.assertions.respondedAtExpectedPoints.pass).toBe(true);
    expect(result.assertions.noEchoedHumanText.pass).toBe(true);
    expect(result.assertions.noDetectedUnsupportedFirstPersonClaims.pass).toBe(
      true,
    );
    expect(result.steps.filter((s) => s.unsolicited)).toHaveLength(10);
  });

  test("a bot that answers before the group is linked fails silentUntilLinked", async () => {
    const room = spec.rooms.find((r) => r.id === "community") as RoomSpec;
    const { result } = await simulate(
      "community",
      scriptedBot(room, { onProbe: () => ["Yes, everyone is here, Rosa."] }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.assertions.silentUntilLinked).toMatchObject({
      pass: false,
      preLinkSends: 1,
      probe: { sender: "Rosa", text: PRE_LINK_PROBE_TEXT },
    });
    expect(
      result.steps.find((s) => s.text.startsWith("(PRE-LINK)")),
    ).toMatchObject({
      unsolicited: true,
    });
  });

  test("a forbidden-claim reply fails the scoped detector; allowed categories do not count", async () => {
    const room = spec.rooms.find((r) => r.id === "household") as RoomSpec;
    let injected = false;
    const { result } = await simulate(
      "household",
      scriptedBot(room, {
        onExpected: (scripted) => {
          if (injected) return [scripted];
          injected = true;
          return [`${scripted} I booked a table and emailed everyone.`];
        },
      }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(
      result.assertions.noDetectedUnsupportedFirstPersonClaims,
    ).toMatchObject({
      pass: false,
      hits: ["email", "booking"],
      allowedCategories: ["durable-memory"],
    });

    // community allows "reminder" (scheduled-reminder steps), so the same
    // claim there is not a hit; "booking" still is.
    const allowed = buildPlan(spec, "community", {}).allowedCategories;
    expect(
      scoreElizaOutput(
        "community",
        allowed,
        [],
        "I set a reminder for Saturday.",
      ).forbiddenHits,
    ).toEqual([]);
    expect(
      scoreElizaOutput("community", allowed, [], "I booked the shade cloth.")
        .forbiddenHits,
    ).toEqual(["booking"]);
  });

  test("link and ambient acks are scanned for forbidden claims too", async () => {
    const room = spec.rooms.find((r) => r.id === "trip") as RoomSpec;
    const { result } = await simulate(
      "trip",
      scriptedBot(room, {
        linkAck: ["Linked. I will email everyone a summary."],
      }),
    );
    expect(
      result.assertions.noDetectedUnsupportedFirstPersonClaims,
    ).toMatchObject({
      pass: false,
      hits: ["email"],
    });
    // The ack itself is not a scored reply: it earns no fact or echo entry.
    const ack = result.steps.find((s) => s.text.startsWith("(link ack)"));
    expect(ack?.matchedFacts).toBeUndefined();
  });

  test("a silent bot fails respondedAtExpectedPoints (and earns no facts or speaker credit)", async () => {
    const room = spec.rooms.find((r) => r.id === "co-parenting") as RoomSpec;
    const { result } = await simulate(
      "co-parenting",
      scriptedBot(room, { onExpected: () => [] }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.assertions.respondedAtExpectedPoints).toEqual({
      pass: false,
      respondedPoints: 0,
      expectedPoints: 6,
      minRequired: 3,
    });
    expect(result.steps.filter((s) => s.silent)).toHaveLength(6);
    expect(result.assertions.keyFactsReferenced.pass).toBe(false);
    expect(result.assertions.speakerAwareness.pass).toBe(false);
    // Silence is still restraint: no unsolicited sends, no pre-link sends.
    expect(result.assertions.restraintAtUnscriptedPoints.pass).toBe(true);
    expect(result.assertions.silentUntilLinked.pass).toBe(true);
  });

  test("a stack that never answers /group is a harness failure, not a verdict", async () => {
    const room = spec.rooms.find((r) => r.id === "trip") as RoomSpec;
    await expect(
      simulate("trip", scriptedBot(room, { dmReply: [] })),
    ).rejects.toThrow(/no DM reply to \/group/);
    await expect(
      simulate("trip", scriptedBot(room, { dmReply: ["Sure, one sec."] })),
    ).rejects.toThrow(/could not parse a link code/);
  });

  test("the markdown transcript carries the verdict, the annotations and the assertions", async () => {
    const room = spec.rooms.find((r) => r.id === "friends") as RoomSpec;
    const { result } = await simulate(
      "friends",
      scriptedBot(room, { onSilent: () => ["Sounds good, Maya!"] }),
    );
    const md = renderMarkdown(result);
    expect(md).toContain("# Room sim transcript: Friends (friends)");
    expect(md).toContain("- Verdict: **FAIL**");
    expect(md).toContain("_[UNSOLICITED]_");
    expect(md).toContain("**Maya:** dinner this weekend?");
    expect(md).toContain("**Eliza:** (DM) Add Eliza to the group");
    expect(md).toContain('"restraintAtUnscriptedPoints"');
    expect(md).toContain("_(silent: expected speaking point at position 20)_");
  });
});

// ── Pure pieces the run relies on ──────────────────────────────────────────

describe("capture filtering", () => {
  const humans = new Set([DEFAULT_OWNER_HANDLE, "+15550001001"]);

  test("keeps only tagged Eliza outputs and counts untagged drops", () => {
    const { entries, untaggedDropped } = normalizeCapturePayload(
      [
        { text: "hello", chat_id: "chat_a" },
        { body: "via body", chatId: "chat_b" },
        { message: "via message", chat: "chat_c" },
        { text: "dm", to: "+15550000001" },
        { text: "inbound copy", chat_id: "chat_a", direction: "inbound" },
        { text: "a human", chat_id: "chat_a", sender: "+15550001001" },
        { text: "a human", chat_id: "chat_a", from: DEFAULT_OWNER_HANDLE },
        { text: "no chat" },
        "bare string",
        null,
        42,
        { chat_id: "chat_a" },
      ],
      humans,
    );
    expect(entries).toEqual([
      { text: "hello", chat: "chat_a" },
      { text: "via body", chat: "chat_b" },
      { text: "via message", chat: "chat_c" },
      { text: "dm", chat: "+15550000001" },
    ]);
    expect(untaggedDropped).toBe(2);
  });

  test("accepts {messages:[...]} and rejects other shapes", () => {
    expect(
      normalizeCapturePayload(
        { messages: [{ text: "x", chat_id: "c" }] },
        humans,
      ).entries,
    ).toEqual([{ text: "x", chat: "c" }]);
    expect(() => normalizeCapturePayload({ nope: true }, humans)).toThrow(
      RoomSimError,
    );
  });

  test("redacts credentials before captured output can reach artifacts", () => {
    expect(
      normalizeCapturePayload(
        [
          {
            text: "Bearer abcdefghijklmnop https://x.test/?token=secret-value",
            chat_id: "c",
          },
        ],
        humans,
      ).entries,
    ).toEqual([
      {
        text: "Bearer [REDACTED] https://x.test/?token=[REDACTED]",
        chat: "c",
      },
    ]);
  });
});

describe("echo detection", () => {
  const humans = ["laundry got left in the washer again lol", "pasta?", "fine"];

  test("flags exact, containment and near-identical outputs", () => {
    expect(
      echoOfHuman("Laundry got left in the washer again, lol.", humans),
    ).toBe(humans[0]);
    expect(
      echoOfHuman(
        "you said: laundry got left in the washer again lol!",
        humans,
      ),
    ).toBe(humans[0]);
    expect(echoOfHuman("laundry got left in the washer again", humans)).toBe(
      humans[0],
    );
  });

  test("does not flag a real reply that shares nouns, or tiny lines", () => {
    expect(
      echoOfHuman(
        "Jules, the laundry is yours this week; the washer is free now.",
        humans,
      ),
    ).toBeNull();
    expect(echoOfHuman("pasta works, Jules can cook", humans)).toBeNull();
    expect(echoOfHuman("", humans)).toBeNull();
  });
});

describe("link code parsing", () => {
  test("prefers the product command shape, then falls back", () => {
    expect(parseLinkCode([DM_REPLY])).toBe(LINK_CODE);
    expect(parseLinkCode(["/eliza_link@SomeBot 7ykh2mnp"])).toBe("7YKH2MNP");
    expect(parseLinkCode(["your code: ABCDEFGH"])).toBe("ABCDEFGH");
    expect(parseLinkCode(["nothing here 01234567"])).toBeNull();
    expect(parseLinkCode(["token=zz-1234"], "token=([a-z0-9-]+)")).toBe(
      "ZZ-1234",
    );
  });
});

describe("webhook envelope", () => {
  test("matches the Blooio v4 group shape the gateway adapter accepts", () => {
    const body = JSON.parse(
      v4Envelope({
        sender: "+15550001001",
        text: "hi",
        chatId: "chat_sim_household",
        isGroup: true,
        roomName: "Household",
        elizaHandle: DEFAULT_ELIZA_HANDLE,
        seq: 3,
      }),
    );
    expect(body.type).toBe("message.received");
    expect(body.data).toMatchObject({
      chat_id: "chat_sim_household",
      direction: "inbound",
      sender: "+15550001001",
      recipient: DEFAULT_ELIZA_HANDLE,
      channel_address: DEFAULT_ELIZA_HANDLE,
      text: "hi",
      is_group: true,
      group: { name: "Household" },
      attachments: [],
    });
    expect(body.data.message_id).toBe(body.data.id);
    expect(body.data.id).toMatch(/^msg_sim_\d+_3$/);
  });
});

describe("webhook signing", () => {
  const body = '{"id":"evt_1"}';

  test("env: mode produces the t=,v1= HMAC the edge and gateway verify", async () => {
    const header = await signatureFor(body, {
      SIGNING: "env:BLOOIO_SECRET",
      BLOOIO_SECRET: "s3cret",
    });
    const [t, v1] = (header ?? "").split(",");
    expect(t).toMatch(/^t=\d+$/);
    const expected = crypto
      .createHmac("sha256", "s3cret")
      .update(`${t.slice(2)}.${body}`)
      .digest("hex");
    expect(v1).toBe(`v1=${expected}`);
    expect(Math.abs(Number(t.slice(2)) - Date.now() / 1000)).toBeLessThan(5);
  });

  test("a bare value is the secret, none/unset means no header, a missing env var is fatal", async () => {
    const bare = await signatureFor(body, { SIGNING: "s3cret" });
    const viaEnv = await signatureFor(body, {
      SIGNING: "env:X",
      X: "s3cret",
    });
    expect(bare?.split(",")[1]).toBe(viaEnv?.split(",")[1]);
    expect(await signatureFor(body, {})).toBeNull();
    expect(await signatureFor(body, { SIGNING: "none" })).toBeNull();
    await expect(
      signatureFor(body, { SIGNING: "env:UNSET_VAR" }),
    ).rejects.toThrow(RoomSimError);
  });

  test("cmd: mode uses the command's stdout verbatim and fails on a non-zero exit", async () => {
    expect(
      await signatureFor(body, { SIGNING: 'cmd:printf "sig:%s" "$BODY"' }),
    ).toBe(`sig:${body}`);
    await expect(signatureFor(body, { SIGNING: "cmd:exit 3" })).rejects.toThrow(
      /SIGNING cmd exited 3/,
    );
  });
});

describe("mock provider capture", () => {
  test("translates the raw outbox into the driver's capture contract", () => {
    const jsonl = [
      JSON.stringify({
        n: 1,
        method: "POST",
        path: "/v4/chats/chat_sim_trip/read",
        body: null,
      }),
      JSON.stringify({
        n: 2,
        method: "POST",
        path: "/v4/chats/chat_sim_trip/typing",
        body: '{"state":"started"}',
      }),
      JSON.stringify({
        n: 3,
        method: "POST",
        path: "/v4/chats/chat_sim_trip/messages",
        body: '{"text":"Meet at arrivals at 10:20."}',
      }),
      JSON.stringify({
        n: 4,
        method: "POST",
        path: "/v4/messages",
        body: '{"text":"Eliza link 6YBJYDMK","to":"+15550000001"}',
      }),
      JSON.stringify({
        n: 5,
        method: "DELETE",
        path: "/v4/chats/chat_sim_trip/typing",
        body: null,
      }),
    ].join("\n");
    expect(captureFromOutbox(jsonl)).toEqual([
      {
        text: "Meet at arrivals at 10:20.",
        chat_id: "chat_sim_trip",
        direction: "outbound",
      },
      {
        text: "Eliza link 6YBJYDMK",
        chat_id: "+15550000001",
        direction: "outbound",
      },
    ]);
    expect(isMessageSend("POST", "/v4/messages")).toBe(true);
    expect(isMessageSend("POST", "/v4/chats/chat_x/messages")).toBe(true);
    expect(isMessageSend("POST", "/v4/chats/chat_x/typing")).toBe(false);
    expect(isMessageSend("GET", "/v4/messages")).toBe(false);
  });

  test("corrupt outbox lines and message bodies fail closed", () => {
    expect(() => captureFromOutbox("garbage line")).toThrow(
      /outbox JSON at line 1/,
    );
    expect(() =>
      captureFromOutbox(
        JSON.stringify({
          n: 1,
          method: "POST",
          path: "/v4/chats/chat%5Fsim/messages",
          body: "not json",
        }),
      ),
    ).toThrow(/message body at line 1/);
  });
});
