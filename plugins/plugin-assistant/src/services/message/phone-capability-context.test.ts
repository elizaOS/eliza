import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  type Action,
  ContextRegistry,
  type IAgentRuntime,
  type Memory,
  renderContextObject,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { requiredFixtureValue } from "../../../test/required-fixture-value.ts";
import { proposeDeviceAction } from "../device-actions/action.ts";

const binding = vi.hoisted(() => ({
  turn: undefined as unknown,
  notes: "runtime",
  calendar: "runtime",
  localCalendarCreate: true,
}));
vi.mock("../device-actions/service.ts", async (original) => ({
  ...(await original<typeof import("../device-actions/service.ts")>()),
  getDeviceActionTurn: () => binding.turn,
  currentAppRecordSource: (_runtime: unknown, domain: string) =>
    domain === "notes" ? binding.notes : binding.calendar,
  readDeviceConversationReceipts: async () => [],
  deviceAppRecordOperationAvailable: (
    _runtime: unknown,
    operation: { type: string },
  ) =>
    operation.type !== "calendar_create_local" || binding.localCalendarCreate,
}));

import { ACKNOWLEDGMENT_RULE } from "../../prompts/acknowledgment.ts";
import { createV5MessageContextObject } from "./context-assembly.ts";
import { replyIsClaimSafeAcknowledgment } from "./side-effect-claims.ts";
import { renderMessageHandlerModelInput } from "./stage1-input.ts";

const capabilities = [
  "notes.local-record.v1",
  "reminders.local-record.v1",
  "reminders.local-record.v2",
  "calendar.create.v1",
  "calendar.next-read.v1",
  "calendar.local-event.v1",
  "clock.alarms.v1",
  "clock.handoff.v2",
  "open_view",
  "create_note",
  "browser_navigate",
];
const native = proposeDeviceAction;
const notes = {
  name: "NOTES_UPDATE",
  description: "Update a canonical note.",
  contexts: ["notes"],
  parameters: [],
} as unknown as Action;
function fixture() {
  const runtime = {
    agentId: "agent",
    character: { name: "Alpha", bio: [], system: "Answer." },
    contexts: new ContextRegistry([
      { id: "general", description: "General tasks" },
      { id: "messaging", description: "Messages" },
      { id: "notes", description: "Saved notes" },
    ]),
    actions: [notes, native],
    providers: [],
    getSetting: () => null,
    getService: () => null,
    getRoom: async () => null,
    getModelRegistrations: () => [],
    reportError: vi.fn(),
    logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  binding.turn = {
    runtime,
    credential: { capabilities },
    viewProfile: { views: ["notes", "home"] },
  };
  binding.notes = "runtime";
  binding.calendar = "runtime";
  return {
    runtime,
    message: {
      id: "message",
      roomId: "room",
      agentId: "agent",
      entityId: "owner",
      content: { text: "Do the requested task." },
    } as Memory,
    state: { values: {}, data: {}, text: "" },
    userRoles: ["OWNER"] as const,
  };
}
async function guidance(options: Record<string, unknown> = {}) {
  const args = fixture();
  const context = await createV5MessageContextObject({ ...args, ...options });
  const event = context.events.find(
    (event) => event.id === "authenticated-phone-capability",
  );
  if (!event || !("content" in event))
    throw Error("Missing capability context");
  return { text: String(event.content), context, args };
}

// The X-Eliza-Device-Capabilities a v609 Alpha image sent (captured on the
// phone), plus phone.keypad.v1 for the keypad handoff.
const ALPHA_IMAGE_CAPABILITIES = [
  "calendar.local-event.v1",
  "notes.local-record.v1",
  "camera.capture-photo.v1",
  "camera.capture-lens.v1",
  "reminders.local-record.v2",
  "notes.list-filter.v1",
  "reminders.create.v1",
  "calendar.create.v1",
  "calendar.next-read.v1",
  "maps.selected-read.v1",
  "files.browser.v1",
  "browser.search.v1",
  "browser.tabs.v1",
  "browser.history.v1",
  "browser.find.v1",
  "calendar.availability-read.v1",
  "photos.library.v1",
  "calendar.named-read.v1",
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
  "messages.read.v1",
  "voicemail.read.v1",
  "voicemail.delete.v1",
  "sms.compose.v2",
  "contacts.write.v2",
  "phone.keypad.v1",
];

describe("phone telephony routing on the Alpha image", () => {
  async function withImage(options: Record<string, unknown>) {
    const args = fixture();
    const turn = binding.turn as {
      credential: { capabilities: string[] };
      isCurrent?: () => boolean;
    };
    turn.credential.capabilities = ALPHA_IMAGE_CAPABILITIES;
    turn.isCurrent = () => true;
    const context = await createV5MessageContextObject({
      ...args,
      ...options,
    });
    const event = context.events.find(
      (event) => event.id === "authenticated-phone-capability",
    );
    return event && "content" in event ? String(event.content) : "";
  }
  it("names the device operation for a call, a text, showing contacts and the dialer while routing", async () => {
    // v609: the call went to Twilio VOICE_CALL, the text to PAGE_DELEGATE,
    // "show my contacts" to the relationship store, "open the dialer" was refused.
    const routing = await withImage({ providerPhase: "response" });
    for (const route of [
      "call a number or contact: phone_call",
      "text or draft a text to a number or contact: sms_compose with target",
      "find or show a named contact, or a named contact's number: contact_show with the name as the query",
      "open the dialer or keypad, with or without a number: phone_keypad, which fills in the keypad and never calls",
      "in the general, phone, messaging or contacts context",
      'a plain request to open or show the Phone, Messages or Contacts app, including "show my contacts" with no name, is navigation to that view',
      // v609 peer evidence: an earlier "no SMS connector" reply was repeated.
      "an earlier reply in this conversation saying calls, texts or contacts were unavailable is outdated",
      "VOICE_CALL (a Twilio call from the agent's number)",
    ])
      expect(routing).toContain(route);
    expect(routing).not.toContain("PROPOSE_DEVICE_ACTION cannot");
    // contact_show needs a non-empty name; an unfiltered "show my contacts"
    // is the Contacts view, which views.explicit-navigation also resolves.
    expect(routing).not.toContain("show contacts or open the dialer");
    expect(routing).not.toMatch(/show[^.;]*the owner's contacts: contact_show/);
  });
  it("keeps the device routes when the planner selected the phone or messaging context", async () => {
    for (const context of ["phone", "messaging"]) {
      const planning = await withImage({
        includeTools: true,
        providerPhase: "planning",
        selectedContexts: [context],
      });
      // The detailed native instructions follow a selected context that carries the device tool.
      expect(planning).toContain("phone_keypad");
      expect(planning).toContain(
        "The authenticated installation enabled-view profile",
      );
    }
  });
  it("names no phone route for a phone without telephony", async () => {
    const routing = (await guidance({ providerPhase: "response" })).text;
    expect(routing).not.toContain("phone_call");
    expect(routing).not.toContain("phone_keypad");
  });
});

describe("selected phone capability guidance", () => {
  it("routes a retry of an unsent Gmail draft through the negotiated composer", async () => {
    const routing = async () =>
      (await guidance({ providerPhase: "response" })).text;
    expect(await routing()).not.toContain("MESSAGE_DRAFT_FOLLOWUP");
    capabilities.push("gmail.local-compose.v1");
    try {
      const text = await routing();
      expect(text).toContain("MESSAGE_DRAFT_FOLLOWUP");
      expect(text).toContain("Do not search or triage the mailbox");
      expect(text).toContain("never sent by this action");
    } finally {
      capabilities.pop();
    }
  });

  it("keeps compact authenticated availability and permission boundaries during routing", async () => {
    const { text } = await guidance({ providerPhase: "response" });
    expect(text).toContain("notes.local-record.v1");
    expect(text).toContain("not permission or completion");
    expect(text).toContain("phone owner's approval");
    expect(text).toContain("VIEWS or VIEWS_SHOW");
    expect(text).not.toContain("Snooze means ten minutes");
  });
  it("closes only the device tool's calls and texts unless the phone negotiated them", async () => {
    const routing = async () =>
      (await guidance({ providerPhase: "response" })).text;
    const all = await routing();
    expect(all).toContain(
      "PROPOSE_DEVICE_ACTION cannot place or dial calls or send or draft text messages with this phone's own Phone and Messages apps.",
    );
    // The runtime may have another call or message tool: it is never told
    // to refuse, or to hide that tool's result.
    expect(all).toContain(
      "Another exposed tool that calls or messages works as usual. When no tool can do it, say plainly",
    );
    expect(all).toContain("was started without a tool result");
    capabilities.push("phone.call.v1");
    try {
      expect(await routing()).toContain(
        "PROPOSE_DEVICE_ACTION cannot send or draft text messages with",
      );
      capabilities.push("sms.compose.v1");
      expect(await routing()).not.toContain("PROPOSE_DEVICE_ACTION cannot");
    } finally {
      capabilities.splice(capabilities.indexOf("phone.call.v1"));
    }
  });
  it("routes the latest SMS sender read only when the phone offers it", async () => {
    const routing = async () =>
      (await guidance({ providerPhase: "response" })).text;
    expect(await routing()).not.toContain("pending phone lookup");
    capabilities.push("sms.latest-sender.v1");
    try {
      const text = await routing();
      expect(text).toContain("pending phone lookup");
      expect(text).toContain("PROPOSE_DEVICE_ACTION sms_latest_sender");
      expect(text).toContain("approved sender suffix");
      const planning = await guidance({
        includeTools: true,
        providerPhase: "planning",
        selectedContexts: ["messaging"],
      });
      expect(planning.text).toContain("phone owner must separately approve");
      const tool = planning.context.events.find(
        (event) => event.type === "tool" && event.tool.name === native.name,
      );
      expect(tool?.type === "tool" && tool.tool.description).toContain(
        "Use sms_latest_sender with no fields",
      );
    } finally {
      capabilities.pop();
    }
  });
  it("names the phone's own calendar create only on a turn that offers it", async () => {
    const planning = async () =>
      (
        await guidance({
          includeTools: true,
          providerPhase: "planning",
          selectedContexts: ["general"],
          preselectedActions: [native],
        })
      ).text;
    expect(await planning()).toContain("calendar_create_local resolves");
    binding.localCalendarCreate = false;
    try {
      expect(await planning()).not.toContain("calendar_create_local");
    } finally {
      binding.localCalendarCreate = true;
    }
  });
  it("does not expand unrelated native instructions for canonical Notes", async () => {
    const { text } = await guidance({
      includeTools: true,
      providerPhase: "planning",
      selectedContexts: ["notes"],
      preselectedActions: [notes],
    });
    expect(text).toContain("Current Notes source: runtime");
    expect(text).not.toContain("calendar_read_next takes no window");
  });
  it("retains complete native instructions when the native tool is selected", async () => {
    const { text } = await guidance({
      includeTools: true,
      providerPhase: "planning",
      selectedContexts: ["general"],
      preselectedActions: [native],
    });
    for (const required of [
      "Snooze means ten minutes",
      "notes.local-record.v1",
      "calendar_read_next takes no window",
      "phone owner must separately approve",
      "only a native receipt establishes completion",
    ])
      expect(text).toContain(required);
  });
  it("routes a phone contact request to the address-book tool, not the relationship store", async () => {
    const withAddressBook = async (options: Record<string, unknown>) => {
      const args = fixture();
      (
        binding.turn as { credential: { capabilities: string[] } }
      ).credential.capabilities = [...capabilities, "contacts.write.v1"];
      const context = await createV5MessageContextObject({
        ...args,
        ...options,
      });
      const event = context.events.find(
        (event) => event.id === "authenticated-phone-capability",
      );
      return event && "content" in event ? String(event.content) : "";
    };
    // The response handler picks contexts from this compact text.
    const routing = await withAddressBook({ providerPhase: "response" });
    expect(routing).toContain("PROPOSE_DEVICE_ACTION contact_create");
    expect(routing).toContain("never ask for a handle, username or platform");
    // A turn planned under the contacts context alone still exposes the tool
    // and its detailed native instructions.
    expect(native.contexts).toContain("contacts");
    const planning = await withAddressBook({
      includeTools: true,
      providerPhase: "planning",
      selectedContexts: ["contacts"],
    });
    expect(planning).toContain("PROPOSE_DEVICE_ACTION contact_create");
    expect(planning).toContain("only a native receipt establishes completion");
    // A phone without the capability is told nothing about its address book.
    const { text } = await guidance({ providerPhase: "response" });
    expect(text).not.toContain("contact_create");
  });
  it("names photo capture as device work, not Camera navigation, on a phone that negotiated it", async () => {
    // v609 real turn: "take a picture" was judged navigation to Camera and the
    // planner finished on VIEWS_SHOW; nothing it always saw named the capture.
    const withCamera = async (options: Record<string, unknown>) => {
      const args = fixture();
      (
        binding.turn as { credential: { capabilities: string[] } }
      ).credential.capabilities = [
        ...capabilities,
        "camera.capture-photo.v1",
        "camera.capture-lens.v1",
      ];
      const context = await createV5MessageContextObject({
        ...args,
        ...options,
      });
      const event = context.events.find(
        (event) => event.id === "authenticated-phone-capability",
      );
      return event && "content" in event ? String(event.content) : "";
    };
    for (const text of [
      await withCamera({ providerPhase: "response" }),
      await withCamera({
        includeTools: true,
        providerPhase: "planning",
        selectedContexts: ["general"],
        preselectedActions: [native],
      }),
    ]) {
      expect(text).toContain("camera_capture_photo (DEVICE_CAMERA_CAPTURE)");
      expect(text).toContain("opening the Camera view takes no photo");
      expect(text).toContain("never navigation alone");
    }
    const { text } = await guidance({ providerPhase: "response" });
    expect(text).not.toContain("camera_capture_photo");
  });
  it("retains Android Clock handoff constraints on a Clock-only installation", async () => {
    const args = fixture();
    (
      binding.turn as { credential: { capabilities: string[] } }
    ).credential.capabilities = ["clock.handoff.v2"];
    const context = await createV5MessageContextObject({
      ...args,
      providerPhase: "planning",
      selectedContexts: ["general"],
      preselectedActions: [native],
    });
    const event = context.events.find(
      (event) => event.id === "authenticated-phone-capability",
    );
    const text = event && "content" in event ? String(event.content) : "";
    expect(text).toContain("clock.handoff.v2");
    expect(text).toContain(
      "Every Clock handoff, including show, needs separate native approval",
    );
  });
  it("uses the exposed surface rather than an unrelated registered native action", async () => {
    const { text } = await guidance({
      includeTools: true,
      providerPhase: "planning",
      selectedContexts: ["general"],
      actionSurface: {
        exposedActionNames: new Set(["NOTES_UPDATE"]),
        summary: {},
      },
    });
    expect(text).not.toContain("Snooze means ten minutes");
  });
  it("preserves detailed native guidance through completion", async () => {
    const { text } = await guidance({
      providerPhase: "completion",
      selectedContexts: ["general"],
      preselectedActions: [native],
    });
    expect(text).toContain("only a native receipt establishes completion");
    expect(text).toContain("calendar.local-event.v1");
  });
  it("keeps unavailable typed source bindings fenced even in compact routing", async () => {
    const args = fixture();
    binding.notes = "unavailable";
    const context = await createV5MessageContextObject({
      ...args,
      providerPhase: "response",
    });
    const event = context.events.find(
      (event) => event.id === "authenticated-phone-capability",
    );
    expect(event && "content" in event ? event.content : "").toContain(
      "Current Notes source: unavailable",
    );
  });
  it.skipIf(
    !process.env.ALPHA_CONTEXT_TRACE_DIR ||
      !process.env.ALPHA_CONTEXT_METRICS_OUT,
  )(
    "measures exact six captured input fixtures without changing any other bytes",
    async () => {
      if (
        !process.env.ALPHA_CONTEXT_TRACE_DIR ||
        !process.env.ALPHA_CONTEXT_METRICS_OUT
      )
        return;
      const compact = (await guidance({ providerPhase: "response" })).text;
      const full = (
        await guidance({
          providerPhase: "completion",
          selectedContexts: ["general"],
          preselectedActions: [native],
        })
      ).text;
      const files = [
        "tj-d3e08344c5fa2b.json",
        "tj-d397d1e9097064.json",
        "tj-d3222aab53c2c1.json",
        "tj-d11efc63fa5dee.json",
        "tj-d07232570872ab.json",
        "tj-cfd6dd80cb33af.json",
      ];
      const results = files.map((file) => {
        const trace = JSON.parse(
          readFileSync(
            `${process.env.ALPHA_CONTEXT_TRACE_DIR}/${file}`,
            "utf8",
          ),
        );
        const stages: Array<{
          type: string;
          before: number;
          after: number;
          saved: number;
          nativeSurface: boolean;
        }> = [];
        let nativeSurface = false;
        for (const stage of trace.stages) {
          const model = stage.model;
          if (!model) continue;
          const keys = Array.isArray(model.tools)
            ? model.tools.map((tool: { name?: string }) => tool.name)
            : Object.keys(model.tools ?? {});
          if (model.modelType === "ACTION_PLANNER" && keys.length)
            nativeSurface = keys.includes("PROPOSE_DEVICE_ACTION");
          const text = model.messages[1].content as string;
          const line = text
            .split("\n")
            .find((line) =>
              line.startsWith(
                "The authenticated installation enabled-view profile",
              ),
            );
          if (!line)
            throw new Error("Missing captured authenticated capability block");
          const routing =
            model.modelType === "RESPONSE_HANDLER" &&
            !stages.some((s) => s.type === "ACTION_PLANNER");
          const replacement = routing || !nativeSurface ? compact : line;
          const candidate = text.replace(line, replacement);
          expect(candidate.replace(replacement, line)).toBe(text);
          stages.push({
            type: model.modelType,
            before: text.length,
            after: candidate.length,
            saved: text.length - candidate.length,
            nativeSurface: !routing && nativeSurface,
          });
        }
        return {
          file,
          compactGuidanceChars: compact.length,
          fullSyntheticGuidanceChars: full.length,
          fullNativeGuidanceSHA256: createHash("sha256")
            .update(full)
            .digest("hex"),
          stages,
        };
      });
      writeFileSync(
        process.env.ALPHA_CONTEXT_METRICS_OUT,
        JSON.stringify(results, null, 2) + "\n",
      );
      expect(results).toHaveLength(6);
      expect(results.every((result) => result.stages[0].saved > 3000)).toBe(
        true,
      );
    },
  );
  it("does not add another runtime's authenticated capability", async () => {
    const args = fixture();
    binding.turn = { ...(binding.turn as object), runtime: {} };
    const context = await createV5MessageContextObject({
      ...args,
      providerPhase: "response",
    });
    expect(
      context.events.some(
        (event) => event.id === "authenticated-phone-capability",
      ),
    ).toBe(false);
  });
});

describe("voice response policy", () => {
  for (const providerPhase of ["response", "planning", "completion"] as const) {
    it(`keeps one spoken policy through the ${providerPhase} context without changing the request`, async () => {
      const args = fixture();
      const literal =
        "Give me a detailed news briefing with all requested sources.";
      args.message.content = {
        ...args.message.content,
        channelType: "VOICE_DM",
        text: literal,
      };
      const context = await createV5MessageContextObject({
        ...args,
        providerPhase,
      });
      const policy = context.staticPrefix?.staticProviders?.filter(
        (segment) => segment.id === "voice-response-style",
      );
      expect(policy).toHaveLength(1);
      expect(requiredFixtureValue(policy)[0].content).toContain(
        "Expand when the user explicitly asks for detail",
      );
      expect(requiredFixtureValue(policy)[0].content).toContain(
        "preserve attribution required",
      );
      expect(requiredFixtureValue(policy)[0].content).toContain(
        "one to three short sentences",
      );
      expect(requiredFixtureValue(policy)[0].content).toContain(
        "takes priority over generic thoroughness",
      );
      expect(requiredFixtureValue(policy)[0].content).toContain(
        "keep complete internal evidence",
      );
      const input =
        providerPhase === "response"
          ? renderMessageHandlerModelInput(args.runtime, context, [], {
              directMessage: true,
              nativeTools: true,
            })
          : renderContextObject(context);
      const rendered = JSON.stringify(input.messages);
      expect(rendered.split("voice_response_style:")).toHaveLength(2);
      expect(rendered).toContain(literal);
      expect(args.message.content.text).toBe(literal);
    });
    for (const channelType of ["DM", "API", "VOICE_GROUP"] as const) {
      it(`leaves ${channelType} ${providerPhase} context without the private-voice policy`, async () => {
        const args = fixture();
        args.message.content = { ...args.message.content, channelType };
        const context = await createV5MessageContextObject({
          ...args,
          providerPhase,
        });
        expect(context.staticPrefix?.staticProviders).toBeUndefined();
        expect(
          JSON.stringify(renderContextObject(context).messages),
        ).not.toContain("voice_response_style:");
      });
    }
  }
});

describe("model acknowledgment authoring grammar", () => {
  it.each([
    "Let me check.",
    "I'll search.",
    "Let me take a look.",
    "I'll look into that.",
    "Checking both.",
    "Let me check your notes.",
    "I'll pull up your calendar.",
    "Let me open Calendar.",
    "I’ll open Calendar.",
  ])("advertises only admitted short prospective forms: %s", (cue) => {
    expect(replyIsClaimSafeAcknowledgment(cue)).toBe(true);
  });
  it("explains arbitrary topics through referents and forbids the incomplete live form", () => {
    expect(ACKNOWLEDGMENT_RULE).toContain(
      "These references work for any topic",
    );
    expect(ACKNOWLEDGMENT_RULE).toContain("a complete lookup phrase");
    expect(ACKNOWLEDGMENT_RULE).toContain(
      "Do not invent other forms or synonyms",
    );
    expect(ACKNOWLEDGMENT_RULE).toContain(
      "leave it empty and still do authorized work",
    );
    expect(replyIsClaimSafeAcknowledgment("let me pull the latest.")).toBe(
      false,
    );
  });
});
