/**
 * The planner's tools on an enrolled-phone turn that offers the device tool.
 *
 * Beside PROPOSE_DEVICE_ACTION the planner was also given whatever retrieval
 * guessed for the turn's contexts: 51 to 89 extra tools across each recorded
 * 36-turn phone conversation (CALENDAR, OWNER_REMINDERS_CREATE, MESSAGE,
 * CONTACT ...), 12% to 18% of planner input. The model called 3 of them per
 * conversation, each a single-operation device tool Stage 1 had named. Tool
 * definitions lead a provider's cached prefix, so each change in the guess
 * also made the system prompt and the history behind it a cache miss.
 *
 * The guesses left out are the ones for contexts the device tool itself
 * declares. A context Stage 1 selected beside those (calendar, tasks ...) keeps
 * its preload: "text Sam and add it to my calendar" starts with the calendar
 * tools too, because given the device tool alone the model proposed the text
 * and did not go looking for the other half.
 *
 * These tests pin the list such a turn starts with, what still loads beside the
 * device tool, that a tool left out is one discovery call away, and the turns
 * that keep their retrieved tools.
 */
import {
  type Action,
  ContextRegistry,
  type Memory,
  ModelType,
  type ToolDefinition,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichChatUiViewMetadata } from "../../../../../packages/agent/src/api/chat-view-metadata.ts";
import {
  closeRuntimeViewRegistry,
  listViews,
  registerPluginViews,
} from "../../../../../packages/agent/src/api/views-registry.ts";
import { mapsPlugin } from "../../../../plugin-maps/src/plugin.ts";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
} from "../../__tests__/stage1/fixtures.ts";
import { DEFAULT_CONTEXT_DEFINITIONS } from "../../runtime/default-contexts.ts";
import { proposeDeviceAction } from "../device-actions/action.ts";
import {
  DeviceActionService,
  setDeviceActionRequestMessage,
  withDeviceActionTurn,
} from "../device-actions/service.ts";
import {
  deviceActionTools,
  registerDeviceBrowserOpenRouting,
  registerDeviceCameraCaptureRouting,
} from "../device-actions/tools.ts";

/** What an Alpha-image phone negotiates for calls, texts, contacts, camera, browser and Clock. */
const PHONE = [
  "camera.capture-photo.v1",
  "camera.capture-lens.v1",
  "browser.search.v1",
  "browser.tabs.v1",
  "browser.find.v1",
  "clock.handoff.v1",
  "clock.handoff.v2",
  "views.telephony.v1",
  "sms.send.v1",
  "phone.dial.v1",
  "phone.call.v1",
  "contacts.write.v1",
  "contacts.show.v1",
  "contacts.read.v1",
  "sms.compose.v1",
  "phone.keypad.v1",
];
const DEVICE_TURN_START = [
  "IGNORE",
  "STOP",
  "DISCOVER_ACTIONS",
  "PROPOSE_DEVICE_ACTION",
  "REPLY",
];
const owner = "00000000-0000-0000-0000-000000000002";

/** A runtime-store tool of the kind retrieval offers for a context. */
const domainTool = (
  name: string,
  contexts: string[],
  description: string,
): Action =>
  ({
    name,
    description,
    contexts,
    parameters: [],
    validate: async () => true,
    handler: async () => ({ success: true }),
  }) as unknown as Action;
const DOMAIN_TOOLS = [
  domainTool(
    "CONTACT",
    ["contacts"],
    "Show, create or update a contact in the assistant's own relationship records.",
  ),
  domainTool(
    "MESSAGE",
    ["messaging", "contacts"],
    "Send or read a connector message to a contact.",
  ),
  domainTool(
    "OWNER_REMINDERS_CREATE",
    ["tasks"],
    "Create a reminder or alarm in the owner's task store.",
  ),
  domainTool("CALENDAR_FEED", ["calendar"], "Read the owner's calendar feed."),
];
/** A second calendar operation, for turns that load more than one tool of a context. */
const CALENDAR_CREATE_EVENT = domainTool(
  "CALENDAR_CREATE_EVENT",
  ["calendar"],
  "Create an event on the owner's calendar.",
);

const runtimes: ReturnType<typeof makeRuntime>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const runtime of runtimes.splice(0)) closeRuntimeViewRegistry(runtime);
});

const reply = (text = "Done.") => ({
  text: "",
  toolCalls: [{ id: "reply", name: "REPLY", arguments: { text } }],
});

/**
 * One owner turn through Stage 1 and the planner with a scripted model.
 * Returns the tool list of each planner request.
 */
async function plannerTools(turn: {
  text: string;
  contexts: string[];
  intents?: string[];
  /** Operations Stage 1 named. */
  named?: string[];
  /** False for a turn that no enrolled phone sent. */
  phone?: boolean;
  /** The registered view the chat is open in. */
  view?: string;
  /** Planner answers in order; a reply ends the turn. */
  planner?: unknown[];
  /** The runtime-store tools registered beside the phone's, in registration order. */
  domainTools?: Action[];
}): Promise<ToolDefinition[][]> {
  const planner = [...(turn.planner ?? [])];
  const runtime = makeRuntime([]);
  runtimes.push(runtime);
  const requests: ToolDefinition[][] = [];
  let decided = false;
  Object.assign(runtime, {
    contexts: new ContextRegistry(DEFAULT_CONTEXT_DEFINITIONS),
    actions: [
      proposeDeviceAction,
      ...deviceActionTools,
      ...(mapsPlugin.actions ?? []),
      ...(turn.domainTools ?? DOMAIN_TOOLS),
    ],
    getRoom: async () => ({ worldId: "world" }),
    getWorld: async () => ({
      id: "world",
      metadata: { roles: { [owner]: "OWNER" }, ownership: { ownerId: owner } },
    }),
    useModel: vi.fn(
      async (type: string, params: { tools?: ToolDefinition[] }) => {
        if (type === ModelType.ACTION_PLANNER) {
          requests.push(structuredClone(params.tools ?? []));
          return planner.shift() ?? reply();
        }
        if (decided)
          return JSON.stringify({
            thought: "Done.",
            success: true,
            decision: "FINISH",
            messageToUser: "Done.",
          });
        decided = true;
        return stage1Response({
          contexts: turn.contexts,
          intents: turn.intents ?? [turn.text],
          candidateActionNames: turn.named ?? [],
          replyText: "On it.",
        });
      },
    ),
  });
  await mapsPlugin.init?.({}, runtime);
  registerDeviceCameraCaptureRouting(runtime);
  registerDeviceBrowserOpenRouting(runtime);
  await registerPluginViews(runtime, mapsPlugin, {
    pluginDir: process.cwd(),
    indexEmbeddings: false,
  });
  const message = makeMessage({
    text: turn.text,
    source: "client_chat",
    channelType: "DM",
    // The chat route replaces renderer metadata with the registered view's facts.
    metadata: enrichChatUiViewMetadata(
      {
        viewDelivery: "completed-action",
        viewClientId: "44444444-4444-4444-8444-444444444444",
        ...(turn.view ? { uiView: turn.view } : {}),
        ...(turn.phone === false
          ? {}
          : {
              clientDevice: {
                context: {
                  revision: 1,
                  view: turn.view ?? "home",
                  sensitive: false,
                },
              },
            }),
      },
      listViews(runtime, { viewType: "gui" }),
    ),
  } as never) as Memory;
  const run = () => runStage1({ runtime, message, state: makeState() });
  if (turn.phone === false) await run();
  else {
    vi.stubEnv("ELIZA_PLATFORM", "android");
    vi.spyOn(DeviceActionService.prototype, "viewProfile").mockResolvedValue(
      null,
    );
    await withDeviceActionTurn(
      runtime,
      {
        subjectUserId: "owner-subject",
        installationId: "installation",
        deviceKey: "device-key",
        capabilities: PHONE,
      } as never,
      async () => {
        setDeviceActionRequestMessage(runtime, message);
        await run();
      },
      {
        isCurrent: () => true,
        requestCaller: {
          subjectUserId: "owner-subject",
          entityId: message.entityId,
          role: "OWNER",
        },
      } as never,
    );
  }
  return requests;
}
/** RESTORE_CONTEXT is the planner's own tool, offered on every request; it is not part of the action surface. */
const names = (tools: ToolDefinition[]) =>
  tools.map((tool) => tool.name).filter((name) => name !== "RESTORE_CONTEXT");

describe("a phone turn that offers the device tool", () => {
  it.each([
    ["contacts", "Show me Jamie's contact."],
    ["messaging", "Send Alex a message: lunch at noon?"],
    ["general", "Set an alarm for 7am."],
  ])(
    "starts a %s request with the device tool and discovery alone: %s",
    async (context, text) => {
      const [first] = await plannerTools({ text, contexts: [context] });
      expect(names(first)).toEqual(DEVICE_TURN_START);
    },
  );

  it("starts with the same tools when every context the device tool declares is selected", async () => {
    const [first] = await plannerTools({
      text: "Text Sam, show me his contact and remind me to call him.",
      contexts: [...(proposeDeviceAction.contexts ?? [])],
      intents: ["Text Sam", "Show Sam's contact", "Remind me to call Sam"],
    });
    expect(names(first)).toEqual(DEVICE_TURN_START);
  });

  it("sends the same tool bytes for different requests in different contexts", async () => {
    const [contact] = await plannerTools({
      text: "Show me Jamie's contact.",
      contexts: ["contacts"],
    });
    const [alarm] = await plannerTools({
      text: "Set an alarm for 7am.",
      contexts: ["general"],
    });
    expect(JSON.stringify(alarm)).toBe(JSON.stringify(contact));
  });

  it("still loads a tool Stage 1 named, and nothing retrieval adds to it", async () => {
    const [first] = await plannerTools({
      text: "Look up Jamie in your records and message her on Discord.",
      contexts: ["contacts", "messaging"],
      intents: ["Look up Jamie in the contact records", "Message Jamie"],
      named: ["CONTACT"],
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "PROPOSE_DEVICE_ACTION",
      "CONTACT",
      "REPLY",
    ]);
  });

  it.each([
    ["camera", "take a picture", ["DEVICE_CAMERA_CAPTURE"]],
    ["browser", "Open example.com", ["DEVICE_BROWSER_OPEN"]],
    [
      "Maps",
      "directions to Coit Tower",
      ["MAPS_NAVIGATION_START", "MAPS_ROUTE"],
    ],
  ])(
    "still loads the tools of the %s direct route",
    async (_route, text, routed) => {
      const [first] = await plannerTools({ text, contexts: ["general"] });
      expect(names(first)).toEqual([
        "IGNORE",
        "STOP",
        "DISCOVER_ACTIONS",
        "PROPOSE_DEVICE_ACTION",
        ...routed,
        "REPLY",
      ]);
    },
  );

  // The view the chat is open in scopes a general turn to its own domain.
  // Those operations load; the alarm in the same request guesses no tool.
  it("still starts a general turn in a foreground view with that view's operations", async () => {
    const [first] = await plannerTools({
      text: "find coffee shops and set an alarm for 7am",
      contexts: ["general"],
      view: "maps",
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "PROPOSE_DEVICE_ACTION",
      "MAPS_COVERAGE",
      "MAPS_NAVIGATE",
      "MAPS_NAVIGATION_START",
      "MAPS_PLACE",
      "MAPS_ROUTE",
      "MAPS_SAVE",
      "MAPS_SELECT",
      "MAPS_SHARE",
      "REPLY",
    ]);
  });

  it("loads a tool it left out when the planner asks discovery for it", async () => {
    const [first, second] = await plannerTools({
      text: "Add a note to Jamie in your own contact records.",
      contexts: ["contacts"],
      planner: [
        {
          text: "",
          toolCalls: [
            {
              id: "discover",
              name: "DISCOVER_ACTIONS",
              arguments: {
                names: ["CONTACT"],
                mode: "load",
                eliza_turn_scope: "more_work_pending",
              },
            },
          ],
        },
      ],
    });
    expect(names(first)).toEqual(DEVICE_TURN_START);
    expect(names(second)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "PROPOSE_DEVICE_ACTION",
      "CONTACT",
      "REPLY",
    ]);
  });
});

describe("a phone turn Stage 1 also routed to a context the device tool does not declare", () => {
  const CALENDAR_TOOLS = [...DOMAIN_TOOLS, CALENDAR_CREATE_EVENT];
  const compound = {
    text: "Text Sam I'll be late and add it to my calendar.",
    contexts: ["messaging", "calendar"],
    intents: ["Text Sam that I'll be late", "Add the delay to the calendar"],
    domainTools: CALENDAR_TOOLS,
  };
  const DEVICE_AND_CALENDAR = [
    "IGNORE",
    "STOP",
    "DISCOVER_ACTIONS",
    "PROPOSE_DEVICE_ACTION",
    "CALENDAR_CREATE_EVENT",
    "REPLY",
  ];

  // Without the phone this turn is also offered MESSAGE (see the last block).
  it("starts with the device tool and that context's tool, and no guess for the device tool's own contexts", async () => {
    const [first] = await plannerTools(compound);
    expect(names(first)).toEqual(DEVICE_AND_CALENDAR);
  });

  it("does the same when Stage 1 named the device tool", async () => {
    const [first] = await plannerTools({
      ...compound,
      named: ["PROPOSE_DEVICE_ACTION"],
    });
    expect(names(first)).toEqual(DEVICE_AND_CALENDAR);
  });

  it("keeps a reminder request's reminder tool on a general and tasks turn", async () => {
    const [first] = await plannerTools({
      text: "Remind me to call mom at 5pm and text her that I will.",
      contexts: ["general", "tasks"],
      intents: ["Create a reminder to call mom at 5pm", "Text mom"],
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "PROPOSE_DEVICE_ACTION",
      "OWNER_REMINDERS_CREATE",
      "REPLY",
    ]);
  });

  it("keeps a tool Stage 1 named from the device tool's own contexts", async () => {
    const [first] = await plannerTools({
      ...compound,
      named: ["PROPOSE_DEVICE_ACTION", "CONTACT"],
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "PROPOSE_DEVICE_ACTION",
      "CALENDAR_CREATE_EVENT",
      "CONTACT",
      "REPLY",
    ]);
  });

  // Tool definitions lead the cached prefix: the same selection must be the
  // same bytes however Stage 1 ordered it, the request worded it or the
  // registry listed it. Retrieval ranks the reminder tool first for the first
  // request and the calendar tool first for the second.
  it("sends the same tool bytes for the same selection in any order", async () => {
    const [first] = await plannerTools({
      text: "Text Sam I'll be late, add it to my calendar and remind me to call him at 5pm.",
      contexts: ["messaging", "calendar", "tasks"],
      intents: [
        "Text Sam that I'll be late",
        "Add the delay to the calendar",
        "Create a reminder to call Sam at 5pm",
      ],
      domainTools: CALENDAR_TOOLS,
    });
    const [reordered] = await plannerTools({
      text: "Create an event on my calendar, text Sam, then create a reminder.",
      contexts: ["calendar", "tasks", "messaging"],
      intents: [
        "Create an event on the calendar",
        "Text Sam",
        "Create a reminder",
      ],
      domainTools: [...CALENDAR_TOOLS].reverse(),
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "PROPOSE_DEVICE_ACTION",
      "CALENDAR_CREATE_EVENT",
      "OWNER_REMINDERS_CREATE",
      "REPLY",
    ]);
    expect(JSON.stringify(reordered)).toBe(JSON.stringify(first));
  });
});

describe("turns that keep the tools retrieval finds", () => {
  it("a turn no phone sent", async () => {
    const [first] = await plannerTools({
      text: "Show me Jamie's contact.",
      contexts: ["contacts"],
      phone: false,
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "CONTACT",
      "REPLY",
    ]);
  });

  it("a compound turn no phone sent, guesses for every context included", async () => {
    const [first] = await plannerTools({
      text: "Text Sam I'll be late and add it to my calendar.",
      contexts: ["messaging", "calendar"],
      intents: ["Text Sam that I'll be late", "Add the delay to the calendar"],
      domainTools: [...DOMAIN_TOOLS, CALENDAR_CREATE_EVENT],
      phone: false,
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "CALENDAR_CREATE_EVENT",
      "MESSAGE",
      "REPLY",
    ]);
  });

  it("a phone turn routed where the device tool is not offered", async () => {
    const [first] = await plannerTools({
      text: "What's on my calendar tomorrow?",
      contexts: ["calendar"],
    });
    expect(names(first)).toEqual([
      "IGNORE",
      "STOP",
      "DISCOVER_ACTIONS",
      "CALENDAR_FEED",
      "REPLY",
    ]);
  });
});
