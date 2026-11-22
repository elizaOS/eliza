/**
 * Pixel v620, "find coffee near the Ferry Building": MAPS_PLACE succeeded
 * with verified user-facing text (a nearest-first list plus a `[MAPSCARD]`
 * places card) and the evaluator also wrote a short grounded answer. The
 * planner composed `"```\n<list + card>\n```\n\n<prose>"` — fencing the
 * card's wire markup as if it were multiline command output, so the user saw
 * literal ``` lines around the list. The card is now delivered unfenced, and
 * the evaluator's prose still follows it (it may answer more than the card). The device model's completion (133 tokens) could not have
 * carried the ~3 KB card: the fence came from the composition step. These
 * tests drive the real planner loop and evaluator with a scripted model.
 */
import { describe, expect, it } from "vitest";
import { runPlannerLoop } from "./planner-loop.ts";
import { containsRenderedCardBlock } from "./rendered-card-blocks.ts";

const PLACES = [
  ["Blue Bottle Coffee", 37.7961181, -122.3939851, "1 Ferry Building #7", 80],
  [
    "SIGNAL Coffee Roasters",
    37.7949561,
    -122.392511,
    "Ferry Building, 1st St",
    110,
  ],
  ["Sana’a cafe", 37.7940385, -122.3967754, "27 Drumm St", 320],
] as const;

const card = {
  kind: "places",
  query: "coffee",
  places: PLACES.map(([name, latitude, longitude, street]) => ({
    name,
    latitude,
    longitude,
    provider: "eliza-cloud",
    providerPlaceId: `place-${name.length}`,
    formattedAddress: `${street}, San Francisco, CA 94111, USA`,
    categories: [],
  })),
  nextCursor: null,
  attribution: "Google Maps",
};

const LIST = [
  "Near Ferry Building:",
  ...PLACES.map(([name, , , , meters]) => `${name}, ${meters} m away`),
].join("\n");

/** plugin-maps `appendMapsCard(list, card)`. */
const VERIFIED = `${LIST}\n\n[MAPSCARD]\n${JSON.stringify(card)}\n[/MAPSCARD]`;

/** The evaluator's messageToUser stored on the device for that turn. */
const EVALUATOR_PROSE =
  "Near the Ferry Building: Blue Bottle Coffee (80 m away), just inside the building, and SIGNAL Coffee Roasters (110 m away, 1st St).";

function mapsPlaceResult(userFacingText: string) {
  return {
    success: true,
    text: `Found ${PLACES.length} places near Ferry Building, nearest first:\n${PLACES.map(
      ([name, , , street, meters]) => `${name}, ${street} (${meters} m away)`,
    ).join("\n")}`,
    userFacingText,
    verifiedUserFacing: true,
    data: { actionName: "MAPS", action: "place", status: "found" },
  };
}

async function run(toolName: string, result: unknown, evaluatorProse: string) {
  let plannerCalls = 0;
  const output = await runPlannerLoop({
    context: {
      id: "verified-card-reply",
      events: [
        {
          id: "stage1",
          type: "message_handler",
          source: "message-service",
          metadata: { plan: { intents: ["Find coffee near a landmark"] } },
        },
      ],
    },
    tools: [{ name: toolName, parameters: { type: "object", properties: {} } }],
    runtime: {
      useModel: async (
        _type: unknown,
        args: { responseSchema?: { properties?: Record<string, unknown> } },
      ) => {
        if (args.responseSchema?.properties?.replyEffectStatus) {
          return JSON.stringify({
            thought: "A maps read with no expected side effect.",
            success: true,
            decision: "FINISH",
            requestFullyCovered: true,
            replyEffectStatus: "none",
            messageToUser: evaluatorProse,
          });
        }
        if (plannerCalls++ === 0) {
          return {
            text: "",
            toolCalls: [
              {
                id: "call-1",
                name: toolName,
                arguments: { action: "place", eliza_turn_scope: "final" },
              },
            ],
          };
        }
        return JSON.stringify({
          completed: true,
          toolCalls: [],
          messageToUser: evaluatorProse,
        });
      },
    },
    executeToolCall: () => structuredClone(result),
  } as never);
  return output;
}

describe("verified tool text that carries a client-rendered card", () => {
  it("never fences the card and keeps the evaluator's prose after it", async () => {
    const output = await run(
      "MAPS_PLACE",
      mapsPlaceResult(VERIFIED),
      EVALUATOR_PROSE,
    );
    expect(output.status).toBe("finished");
    const reply = output.finalMessage ?? "";
    expect(reply).not.toContain("```");
    expect(reply).toBe(`${VERIFIED}\n\n${EVALUATOR_PROSE}`);
  });

  it("keeps an answer the card does not show", async () => {
    const answer = "Of those, Blue Bottle Coffee opens earliest, at 6:30.";
    const output = await run("MAPS_PLACE", mapsPlaceResult(VERIFIED), answer);
    expect(output.finalMessage).toBe(`${VERIFIED}\n\n${answer}`);
  });

  it("keeps a single-place card unfenced too", async () => {
    const placeCard = `579 Hayes St — 579 Hayes St, San Francisco, CA 94102, USA\n\n[MAPSCARD]\n${JSON.stringify(
      {
        kind: "place",
        place: card.places[0],
        attribution: "Google Maps",
      },
    )}\n[/MAPSCARD]`;
    const output = await run(
      "MAPS_PLACE",
      mapsPlaceResult(placeCard),
      "You're at 579 Hayes St in San Francisco.",
    );
    expect(output.finalMessage).toBe(
      `${placeCard}\n\nYou're at 579 Hayes St in San Francisco.`,
    );
  });

  it.each([
    "Filesystem Size Used Avail Use%\n/dev/sda1 450G 428G 22G 95%",
    'Filesystem metadata:\n[REPORT]\n{"available":"22G"}\n[/REPORT]',
  ])(
    "still fences multiline command output and keeps the evaluator's answer: %s",
    async (table) => {
      const output = await run(
        "BASH",
        {
          success: true,
          text: table,
          userFacingText: table,
          verifiedUserFacing: true,
          data: { actionName: "BASH" },
        },
        "The disk is still 95% full with 22G free.",
      );
      expect(output.finalMessage).toBe(
        `\`\`\`\n${table}\n\`\`\`\n\nThe disk is still 95% full with 22G free.`,
      );
    },
  );
});

describe("containsRenderedCardBlock", () => {
  it("recognizes the supported JSON-bodied card blocks", () => {
    expect(containsRenderedCardBlock(VERIFIED)).toBe(true);
    expect(
      containsRenderedCardBlock('[CHECKLIST]\n{"items":[]}\n[/CHECKLIST]'),
    ).toBe(true);
    expect(
      containsRenderedCardBlock('[WORKFLOW]\n{"steps":[]}\n[/WORKFLOW]'),
    ).toBe(true);
  });

  it("treats literal, unclosed, mismatched or non-JSON brackets as text", () => {
    expect(containsRenderedCardBlock("See [MAPSCARD] in the docs.")).toBe(
      false,
    );
    expect(containsRenderedCardBlock('[MAPSCARD]\n{"kind":"place"}')).toBe(
      false,
    );
    expect(
      containsRenderedCardBlock('[MAPSCARD]\n{"kind":"place"}\n[/CHECKLIST]'),
    ).toBe(false);
    expect(
      containsRenderedCardBlock("[MAPSCARD]\n{not json}\n[/MAPSCARD]"),
    ).toBe(false);
    expect(containsRenderedCardBlock("[NOTE]\n[1,2]\n[/NOTE]")).toBe(false);
  });
});
