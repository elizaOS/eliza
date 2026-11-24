/**
 * Local measurement only (not committed): a prototype of the request-scoped
 * projection of PROPOSE_DEVICE_ACTION. It renders the tool through the real
 * capability filter, decides per request which operation types to load, and
 * writes sizes and outcomes for three request sets to CTX_PROJECTION_OUT.
 * CTX_CAPABILITIES (JSON array) replaces the built-in phone capability list.
 */
import { writeFileSync } from "node:fs";
import {
  type Action,
  type ActionParameterSchema,
  actionToTool,
} from "@elizaos/core";
import { expect, it } from "vitest";
import {
  deviceActionForCapabilities,
  proposeDeviceAction,
} from "../services/device-actions/action";
import { authoredCameraCapture } from "../services/device-actions/camera-request";
import {
  authoredKeypadRequest,
  authoredTelephonyRequest,
} from "../services/device-actions/telephony-request";

const PHONE_CAPABILITIES = [
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
  "browser.open-new-tab.v1",
  "calendar.availability-read.v1",
  "photos.library.v1",
  "calendar.named-read.v1",
  "clock.handoff.v1",
  "clock.handoff.v2",
  "views.telephony.v1",
  "sms.send.v1",
  "phone.dial.v1",
  "sms.latest-sender.v1",
  "phone.call.v1",
  "contacts.write.v1",
  "contacts.show.v1",
  "contacts.read.v1",
  "sms.compose.v1",
  "messages.read.v1",
  "voicemail.read.v1",
  "voicemail.delete.v1",
  "phone.keypad.v1",
  "sms.compose.v2",
  "contacts.write.v2",
];
const CAPABILITIES = process.env.CTX_CAPABILITIES
  ? (JSON.parse(process.env.CTX_CAPABILITIES) as string[])
  : PHONE_CAPABILITIES;
const OUT = process.env.CTX_PROJECTION_OUT;

function estimateTokens(text: string): number {
  let pieces = 0;
  for (const match of text.matchAll(/[A-Za-z]+|[0-9]+|[^A-Za-z0-9\s]+/g)) {
    const run = match[0];
    const code = run.charCodeAt(0);
    if (code >= 48 && code <= 57) pieces += Math.ceil(run.length / 3);
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))
      pieces += run.length <= 10 ? 1 : Math.ceil(run.length / 5);
    else pieces += Math.ceil(run.length / 2);
  }
  return Math.round(pieces / 1.1);
}

// ---------------------------------------------------------------------------
// Operation families: every operation type belongs to exactly one.
// ---------------------------------------------------------------------------

const FAMILIES = [
  "calls",
  "texts",
  "contacts",
  "clock",
  "camera",
  "reminders",
  "notes",
  "calendar",
  "files",
  "browser",
  "maps",
  "photos",
  "views",
] as const;
type Family = (typeof FAMILIES)[number];

/** What the owner would ask for; shown beside the operation names of a family that is not loaded. */
const FAMILY_LABEL: Record<Family, string> = {
  calls: "call or dial a number or contact, dialer keypad, open voicemail",
  texts: "text, draft or reply by SMS, read the open thread, latest sender",
  contacts: "show, add, change or delete a phone contact",
  clock: "set, show, dismiss or snooze an alarm in Clock",
  camera: "take a photo or selfie",
  reminders: "phone reminders",
  notes: "phone notes",
  calendar: "phone calendar events and free/busy",
  files: "files and folders on the phone",
  browser:
    "web search, tabs, find on page, back and reload, open a typed address",
  maps: "share the selected place or route",
  photos: "filter, open, album or share in Photos",
  views: "open an app view",
};

function familyOf(type: string): Family {
  if (type.startsWith("phone_") || type.startsWith("voicemail_"))
    return "calls";
  if (type.startsWith("sms_") || type.startsWith("messages_")) return "texts";
  if (type.startsWith("contact_")) return "contacts";
  if (type.startsWith("clock_")) return "clock";
  if (type.startsWith("camera_")) return "camera";
  if (type.startsWith("reminder_") || type === "create_reminder")
    return "reminders";
  if (type.startsWith("notes_") || type === "create_note") return "notes";
  if (type.startsWith("calendar_")) return "calendar";
  if (type.startsWith("files_")) return "files";
  if (type.startsWith("browser_")) return "browser";
  if (type.startsWith("maps_")) return "maps";
  if (type.startsWith("photos_")) return "photos";
  if (type === "open_view") return "views";
  // A new operation must be assigned before it can be hidden behind the index.
  throw new Error(`Device operation has no family: ${type}`);
}

// ---------------------------------------------------------------------------
// Projection: the real capability filter, then the request filter, an index
// of what is not loaded and the branch that loads it.
// ---------------------------------------------------------------------------

function operationBranches(action: Action): ActionParameterSchema[] {
  return (
    action.parameters?.find((parameter) => parameter.name === "operation")
      ?.schema.anyOf ?? []
  );
}
function branchType(branch: ActionParameterSchema): string {
  return String(branch.properties?.type?.enum?.[0]);
}
function withBranches(
  action: Action,
  keep: (type: string) => boolean,
): Action {
  return {
    ...action,
    parameters: action.parameters?.map((parameter) => {
      if (parameter.name !== "operation") return parameter;
      const schema = structuredClone(parameter.schema);
      schema.anyOf = schema.anyOf?.filter((branch) => keep(branchType(branch)));
      return { ...parameter, schema };
    }),
  };
}

const LOAD_OPERATION = "load_operations";
const phoneTool = deviceActionForCapabilities(proposeDeviceAction, CAPABILITIES);
const phoneTypes = [...new Set(operationBranches(phoneTool).map(branchType))];
const phoneFamilies = FAMILIES.filter((family) =>
  phoneTypes.some((type) => familyOf(type) === family),
);
const typesOfFamily = (family: Family) =>
  phoneTypes.filter((type) => familyOf(type) === family);

type IndexStyle = "labelled" | "names" | "labels";

/** The tool with only `loaded` operation types, or the whole tool when that hides nothing. */
function projectDeviceTool(
  loaded: ReadonlySet<string>,
  style: IndexStyle = "labelled",
): Action {
  const hidden = phoneTypes.filter((type) => !loaded.has(type));
  if (hidden.length === 0) return phoneTool;
  // Passing the filtered schema through the real function makes it drop the
  // guidance of every operation that is not offered, exactly as it does for
  // an operation the phone did not negotiate.
  const scoped = deviceActionForCapabilities(
    withBranches(proposeDeviceAction, (type) => loaded.has(type)),
    CAPABILITIES,
  );
  const hiddenFamilies = phoneFamilies.filter((family) =>
    hidden.some((type) => familyOf(type) === family),
  );
  const names = (family: Family) =>
    hidden.filter((type) => familyOf(type) === family).join(", ");
  const index =
    `Only part of this phone's operations is loaded on this step. Not loaded: ${hiddenFamilies
      .map((family) =>
        style === "names"
          ? `${family} (${names(family)})`
          : style === "labels"
            ? `${family} (${FAMILY_LABEL[family]})`
            : `${family} (${FAMILY_LABEL[family]}: ${names(family)})`,
      )
      .join("; ")}. ` +
    `To use one, call this tool with operation {"type":"${LOAD_OPERATION}","families":[...]}: it proposes nothing and the operations arrive on the next step. Never use another tool, or tell the owner the phone cannot do it, because an operation is not loaded.`;
  return {
    ...scoped,
    description: `${index} ${scoped.description}`,
    parameters: scoped.parameters?.map((parameter) =>
      parameter.name !== "operation"
        ? parameter
        : {
            ...parameter,
            schema: {
              ...parameter.schema,
              anyOf: [
                ...(parameter.schema.anyOf ?? []),
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "families"],
                  properties: {
                    type: { type: "string", enum: [LOAD_OPERATION] },
                    families: {
                      type: "array",
                      items: { type: "string", enum: [...hiddenFamilies] },
                    },
                  },
                },
              ],
            },
          },
    ),
  };
}

function toolSize(action: Action) {
  const tool = actionToTool(action as never) as unknown as {
    function: { description: string; parameters: unknown };
  };
  const json = JSON.stringify(tool);
  return {
    chars: json.length,
    tokens: estimateTokens(json),
    description: tool.function.description.length,
    parameters: JSON.stringify(tool.function.parameters).length,
  };
}

// ---------------------------------------------------------------------------
// Relevance: which families a request can need, decided without a model call.
// ---------------------------------------------------------------------------

const LEXICON: ReadonlyArray<readonly [RegExp, readonly Family[]]> = [
  [
    /\b(?:call(?:s|ed|ing)?|ring(?:s|ing)?|dial(?:s|ed|ing|led|ling)?|redial|dialer|dial\s?-?pad|key\s?-?pad|number\s+pad|voicemails?|missed\s+calls?|on\s+the\s+line|get\s+\S+(?:\s+\S+)?\s+on\s+the\s+phone|speaker\s?phone|hang\s+up)\b/iu,
    ["calls"],
  ],
  [
    /\b(?:text(?:s|ed|ing)?|sms|messages?|messaged|messaging|msg|repl(?:y|ies|ying)|respond|write\s+back|let\s+\S+(?:\s+\S+)?\s+know|tell\s+(?!me\b|us\b|the\s+(?:owner|user)\b)\S+|send\s+(?!me\b|us\b|the\s+(?:owner|user)\b)\S+|drop\s+\S+(?:\s+\S+)?\s+a\s+line)\b/iu,
    ["texts"],
  ],
  [
    /\b(?:contacts?|address\s+book|phone\s+number|(?:number|email|e-mail|cell|mobile)\s+(?:for|of))\b|['’]s\s+(?:number|email|e-mail|cell|mobile)\b/iu,
    ["contacts"],
  ],
  // A person is the target and the channel is not said.
  [
    /\b(?:ping|reach(?:\s+out)?|get\s+(?:a\s+)?hold\s+of|get\s+in\s+touch|touch\s+base|check\s+in\s+with|hit\s+up|holler|give\s+\S+(?:\s+\S+)?\s+a\s+(?:call|ring|buzz|bell|shout))\b/iu,
    ["calls", "texts", "contacts"],
  ],
  [
    /\b(?:alarms?|wake\s+(?:me|us|him|her|them)|wake-?up|get\s+me\s+up|snooze|clock|bedtime)\b/iu,
    ["clock"],
  ],
  [
    /\b(?:photos?|photographs?|pictures?|pics?|selfies?|snap(?:shot)?|camera)\b/iu,
    ["camera"],
  ],
  [
    /\b(?:remind(?:s|ed|er|ers|ing)?|don['’]?t\s+let\s+me\s+forget|remember\s+to|nudge\s+me)\b/iu,
    ["reminders"],
  ],
  [/\b(?:notes?|jot|write\s+(?:(?:this|that|it)\s+)?down|memos?)\b/iu, ["notes"]],
  [
    /\b(?:calendars?|events?|meetings?|appointments?|schedul(?:e|ed|es|ing)|agenda|(?:am\s+i|are\s+we|i['’]?m)\s+(?:free|busy|available)|availability)\b/iu,
    ["calendar"],
  ],
  [/\b(?:files?|folders?|downloads?|documents?|pdfs?|storage)\b/iu, ["files"]],
  [
    /\b(?:brows(?:e|er|ing)|tabs?|web(?:site|page)?|google|look\s+up|search|url|link|go\s+(?:back|forward)|reload|refresh)\b|https?:\/\/|\bwww\.|\b[\w-]+\.(?:com|org|net|io|dev|app|co)\b/iu,
    ["browser"],
  ],
  [
    /\b(?:maps?|directions?|routes?|navigat(?:e|ion)|nearby|near\s+me)\b/iu,
    ["maps"],
  ],
  [
    /\b(?:open|show|go\s+to|switch\s+to|take\s+me\s+to|bring\s+up|launch)\b/iu,
    ["views"],
  ],
];
// "Open" and "show" fit almost any request; they never make a request a device request.
const WEAK_FAMILIES: ReadonlySet<Family> = new Set(["views"]);
const GENERIC_DEVICE =
  /\b(?:on|in|with|from|using|through|via)\s+(?:my|this|the)\s+(?:phone|device|cell|mobile)\b|\b(?:my|this)\s+(?:phone|device)\b/iu;
const FOLLOW_UP =
  /^(?:ok(?:ay)?|yes|yeah|yep|sure|no|actually)\b|\b(?:it|that|this|them|those|again|instead|same)\b/iu;

const CONTEXT_FAMILIES: Record<string, readonly Family[]> = {
  phone: ["calls"],
  messaging: ["texts"],
  contacts: ["contacts"],
  media: ["camera"],
  tasks: ["reminders", "clock"],
  reminders: ["reminders"],
  calendar: ["calendar"],
  notes: ["notes"],
  files: ["files"],
  browser: ["browser"],
  maps: ["maps"],
};
const VIEW_FAMILY: Record<string, Family> = {
  phone: "calls",
  messages: "texts",
  contacts: "contacts",
  notes: "notes",
  reminders: "reminders",
  calendar: "calendar",
  files: "files",
  browser: "browser",
  camera: "camera",
  maps: "maps",
  photos: "photos",
};
const SELECTION_FAMILY: Record<string, Family> = {
  note: "notes",
  reminder: "reminders",
  "calendar-event": "calendar",
  "map-place": "maps",
  "map-route": "maps",
  contact: "contacts",
  thread: "texts",
  voicemail: "calls",
  file: "files",
};
// Any request can name a person without naming the channel, so the three
// operations that reach a person are loaded on every projected step.
const REACH_A_PERSON = ["phone_call", "sms_compose", "contact_show"];

type Evidence = {
  text: string;
  /** Stage-1 intents. */
  intents: readonly string[];
  /** Stage-1 selected contexts. */
  contexts: readonly string[];
  view?: string;
  selectionKind?: string;
  /** Action names from routing rules and Stage-1 evaluators. */
  candidates?: readonly string[];
  /** Families of device proposals made in the previous two turns. */
  recent?: readonly Family[];
  /** Another action was already selected for the planner surface. */
  otherActionSelected: boolean;
};
type Variant = {
  /** Load REACH_A_PERSON on every projected step. */
  core: boolean;
  /** The showing view alone keeps a request that names nothing off the whole tool. */
  viewClaims: boolean;
  /** Stage-1 intents that name no operation keep the request off the whole tool. */
  intentsClaim: boolean;
};
type Decision = {
  mode: "full" | "projected";
  /** Loaded operation types, in schema order. */
  types: string[];
  reason: string;
};

function lexicalFamilies(text: string): Family[] {
  return LEXICON.flatMap(([pattern, families]) =>
    pattern.test(text) ? families : [],
  );
}
function unreadable(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return true;
  const latin = letters.filter((letter) => /\p{Script=Latin}/u.test(letter));
  return latin.length / letters.length < 0.7;
}

function decideProjection(evidence: Evidence, variant: Variant): Decision {
  const text = evidence.text.trim();
  const named = new Set<Family>([
    ...lexicalFamilies(text),
    ...evidence.intents.flatMap(lexicalFamilies),
    // The whole-message routing rules that already promote the device tool.
    ...(authoredTelephonyRequest(text) === "call" ? (["calls"] as const) : []),
    ...(authoredTelephonyRequest(text) === "text" ? (["texts"] as const) : []),
    ...(authoredKeypadRequest(text) ? (["calls"] as const) : []),
    ...(authoredCameraCapture(text) ? (["camera"] as const) : []),
  ]);
  const strong = [...named].filter((family) => !WEAK_FAMILIES.has(family));
  // What a request that names nothing can still be about.
  const claimed = new Set<Family>([
    ...evidence.contexts.flatMap((context) => CONTEXT_FAMILIES[context] ?? []),
    ...(evidence.selectionKind && SELECTION_FAMILY[evidence.selectionKind]
      ? [SELECTION_FAMILY[evidence.selectionKind]]
      : []),
    ...(strong.length === 0 && FOLLOW_UP.test(text)
      ? (evidence.recent ?? [])
      : []),
  ]);
  const showing =
    strong.length === 0 && evidence.view ? VIEW_FAMILY[evidence.view] : undefined;
  if (strong.length === 0) {
    if (unreadable(text))
      return { mode: "full", types: [], reason: "unreadable request" };
    if (
      GENERIC_DEVICE.test(text) ||
      evidence.intents.some((intent) => GENERIC_DEVICE.test(intent)) ||
      evidence.candidates?.includes("PROPOSE_DEVICE_ACTION")
    )
      return {
        mode: "full",
        types: [],
        reason: "device named without an operation",
      };
    if (
      claimed.size === 0 &&
      !(variant.viewClaims && showing) &&
      !(variant.intentsClaim && evidence.intents.length > 0) &&
      !evidence.otherActionSelected
    )
      return { mode: "full", types: [], reason: "nothing claims the turn" };
  }
  const types = phoneTypes.filter((type) => {
    const family = familyOf(type);
    return (
      named.has(family) ||
      claimed.has(family) ||
      family === showing ||
      (variant.core && REACH_A_PERSON.includes(type))
    );
  });
  return {
    mode: "projected",
    types,
    reason:
      strong.length > 0
        ? "request names operations"
        : claimed.size > 0
          ? "context, selection or follow-up"
          : showing
            ? "showing view"
            : evidence.otherActionSelected
              ? "another action owns the turn"
              : "first stage named another goal",
  };
}

// A projection that keeps most of the tool is sent whole: one stable form.
const FULL_SHARE = 0.7;

// ---------------------------------------------------------------------------
// Request sets. `expect` lists the operation types the request needs (all of
// them); `expectAny` accepts any one; "*" means the operation cannot be known
// from the request, so only the whole tool is safe. Neither field means no
// device operation. `stage1` is the routing a correct first stage would
// plausibly give. The tuning set was written with the lexicon. The first
// held-out set was written after the lexicon was frozen; it showed that the
// showing view must not keep a request off the whole tool and that requests
// naming only a person were missed, which led to the second variant. The
// second held-out set was written after that variant was fixed. The lexicon
// is the same for all three sets.
// ---------------------------------------------------------------------------

type PhoneRequest = {
  id: string;
  group: string;
  text: string;
  view: string;
  selectionKind?: string;
  recent?: readonly Family[];
  expect?: readonly string[];
  expectAny?: readonly string[];
  stage1: {
    contexts: readonly string[];
    intents: readonly string[];
    otherActionSelected?: boolean;
  };
};

const TUNING: readonly PhoneRequest[] = [
  {
    id: "call-1",
    group: "call",
    text: "call mom",
    view: "chat",
    expect: ["phone_call"],
    stage1: { contexts: ["phone", "general"], intents: ["call the owner's mother"] },
  },
  {
    id: "call-2",
    group: "call",
    text: "can you ring the dentist at 415-555-0100",
    view: "maps",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["place a phone call to 415-555-0100"] },
  },
  {
    id: "call-3",
    group: "call (vague)",
    text: "get mom on the line",
    view: "notes",
    expect: ["phone_call"],
    stage1: { contexts: ["phone", "general"], intents: ["call the owner's mother"] },
  },
  {
    id: "text-1",
    group: "text",
    text: "text Sam saying running 10 minutes late",
    view: "chat",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["send Sam a text message saying running 10 minutes late"],
      otherActionSelected: true,
    },
  },
  {
    id: "text-2",
    group: "text (vague)",
    text: "ping my brother",
    view: "maps",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging", "general"],
      intents: ["send a message to the owner's brother"],
      otherActionSelected: true,
    },
  },
  {
    id: "text-3",
    group: "text (vague)",
    text: "let Dana know I'm on my way",
    view: "browser",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["tell Dana the owner is on the way"],
      otherActionSelected: true,
    },
  },
  {
    id: "text-4",
    group: "text",
    text: "who texted me last?",
    view: "chat",
    expect: ["sms_latest_sender"],
    stage1: {
      contexts: ["messaging"],
      intents: ["find who sent the latest incoming SMS"],
      otherActionSelected: true,
    },
  },
  {
    id: "text-5",
    group: "text (open thread)",
    text: "reply for me: sounds good, see you then",
    view: "messages",
    selectionKind: "thread",
    expect: ["sms_reply_selected"],
    stage1: {
      contexts: ["messaging"],
      intents: ["draft a reply in the open conversation"],
      otherActionSelected: true,
    },
  },
  {
    id: "text-6",
    group: "text (open thread)",
    text: "read this to me",
    view: "messages",
    selectionKind: "thread",
    expect: ["messages_read_selected"],
    stage1: { contexts: ["general"], intents: ["read the open item aloud"] },
  },
  {
    id: "contact-1",
    group: "contact",
    text: "what's Priya's number?",
    view: "chat",
    expect: ["contact_show"],
    stage1: { contexts: ["contacts"], intents: ["show Priya's phone number"] },
  },
  {
    id: "contact-2",
    group: "contact",
    text: "add a contact for Alex Kim, 415-555-0134",
    view: "calendar",
    expect: ["contact_create"],
    stage1: {
      contexts: ["contacts"],
      intents: ["create a phone contact for Alex Kim with a number"],
    },
  },
  {
    id: "contact-3",
    group: "contact (vague)",
    text: "I need to reach Dr. Patel",
    view: "chat",
    expectAny: ["phone_call", "sms_compose", "contact_show"],
    stage1: {
      contexts: ["contacts", "general"],
      intents: ["help the owner contact Dr. Patel"],
    },
  },
  {
    id: "keypad-1",
    group: "dialer/keypad",
    text: "open the dialer",
    view: "maps",
    expect: ["phone_keypad"],
    stage1: { contexts: ["phone", "general"], intents: ["open the phone keypad"] },
  },
  {
    id: "keypad-2",
    group: "dialer/keypad",
    text: "open the keypad and type 415 302 4399",
    view: "chat",
    expect: ["phone_keypad"],
    stage1: {
      contexts: ["phone"],
      intents: ["open the phone keypad with the number filled in"],
    },
  },
  {
    id: "voicemail-1",
    group: "voicemail",
    text: "delete this voicemail",
    view: "phone",
    selectionKind: "voicemail",
    expect: ["voicemail_delete_selected"],
    stage1: { contexts: ["phone"], intents: ["delete the open voicemail"] },
  },
  {
    id: "camera-1",
    group: "camera",
    text: "take a selfie",
    view: "chat",
    expect: ["camera_capture_photo"],
    stage1: {
      contexts: ["media", "general"],
      intents: ["take a selfie with the front camera"],
      otherActionSelected: true,
    },
  },
  {
    id: "camera-2",
    group: "camera",
    text: "snap a pic of this for me",
    view: "maps",
    expect: ["camera_capture_photo"],
    stage1: {
      contexts: ["media"],
      intents: ["take a photo"],
      otherActionSelected: true,
    },
  },
  {
    id: "alarm-1",
    group: "alarm",
    text: "set an alarm for 6:30 tomorrow",
    view: "chat",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["set an alarm for 6:30 tomorrow morning"],
      otherActionSelected: true,
    },
  },
  {
    id: "alarm-2",
    group: "alarm (vague)",
    text: "wake me at 7",
    view: "browser",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks", "general"],
      intents: ["set a 7:00 wake-up alarm"],
      otherActionSelected: true,
    },
  },
  {
    id: "alarm-3",
    group: "alarm (follow-up)",
    text: "actually make it 7:15",
    view: "chat",
    recent: ["clock"],
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["change the alarm just set to 7:15"],
      otherActionSelected: true,
    },
  },
  {
    id: "reminder-1",
    group: "reminder",
    text: "remind me in 20 minutes to check the oven",
    view: "chat",
    expect: ["reminder_create_after"],
    stage1: {
      contexts: ["tasks"],
      intents: ["create a reminder in 20 minutes to check the oven"],
      otherActionSelected: true,
    },
  },
  {
    id: "reminder-2",
    group: "reminder",
    text: "remind me to call the bank tomorrow at 9",
    view: "chat",
    expect: ["reminder_create"],
    stage1: {
      contexts: ["tasks"],
      intents: ["create a reminder for tomorrow 9:00 to call the bank"],
      otherActionSelected: true,
    },
  },
  {
    id: "note-1",
    group: "note (canonical store)",
    text: "jot down a note: garage code changed",
    view: "chat",
    stage1: {
      contexts: ["notes"],
      intents: ["create a note saying the garage code changed"],
      otherActionSelected: true,
    },
  },
  {
    id: "note-2",
    group: "note (selected phone note)",
    text: "delete it",
    view: "notes",
    selectionKind: "note",
    expect: ["notes_delete"],
    stage1: {
      contexts: ["notes"],
      intents: ["delete the selected note"],
      otherActionSelected: true,
    },
  },
  {
    id: "calendar-1",
    group: "calendar (canonical store)",
    text: "what's on my calendar tomorrow?",
    view: "chat",
    stage1: {
      contexts: ["calendar"],
      intents: ["list tomorrow's calendar events"],
      otherActionSelected: true,
    },
  },
  {
    id: "calendar-2",
    group: "calendar (phone)",
    text: "add lunch with Sam on Friday at noon to my phone's calendar",
    view: "chat",
    expect: ["calendar_create_local"],
    stage1: {
      contexts: ["calendar"],
      intents: ["create a phone calendar event for lunch with Sam on Friday at noon"],
      otherActionSelected: true,
    },
  },
  {
    id: "calendar-3",
    group: "calendar (phone)",
    text: "am I free Thursday afternoon?",
    view: "chat",
    expect: ["calendar_availability"],
    stage1: {
      contexts: ["calendar"],
      intents: ["check free/busy for Thursday afternoon"],
      otherActionSelected: true,
    },
  },
  {
    id: "files-1",
    group: "files",
    text: "show my downloads folder",
    view: "chat",
    expectAny: ["files_filter", "files_open"],
    stage1: {
      contexts: ["files"],
      intents: ["show the Downloads folder in Files"],
      otherActionSelected: true,
    },
  },
  {
    id: "files-2",
    group: "files",
    text: "find the pdf I saved last week",
    view: "files",
    expect: ["files_filter"],
    stage1: {
      contexts: ["files"],
      intents: ["filter files to PDFs from last week"],
      otherActionSelected: true,
    },
  },
  {
    id: "browser-1",
    group: "browser",
    text: "search the web for best ramen near me",
    view: "chat",
    expect: ["browser_search"],
    stage1: {
      contexts: ["browser", "web", "general"],
      intents: ["search the web for best ramen near me"],
      otherActionSelected: true,
    },
  },
  {
    id: "browser-2",
    group: "browser",
    text: "close this tab",
    view: "browser",
    expect: ["browser_tab_close"],
    stage1: {
      contexts: ["browser"],
      intents: ["close the showing browser tab"],
      otherActionSelected: true,
    },
  },
  {
    id: "browser-3",
    group: "browser",
    text: "go back",
    view: "browser",
    expect: ["browser_history"],
    stage1: {
      contexts: ["browser", "general"],
      intents: ["go back one page"],
      otherActionSelected: true,
    },
  },
  {
    id: "maps-1",
    group: "maps (not a device operation)",
    text: "directions to the airport",
    view: "maps",
    stage1: {
      contexts: ["maps", "general"],
      intents: ["route to the airport"],
      otherActionSelected: true,
    },
  },
  {
    id: "maps-2",
    group: "maps (selected place)",
    text: "what's the address here?",
    view: "maps",
    selectionKind: "map-place",
    expect: ["maps_read_selected"],
    stage1: {
      contexts: ["maps", "general"],
      intents: ["tell the owner the selected place's address"],
      otherActionSelected: true,
    },
  },
  {
    id: "chat-1",
    group: "plain chat",
    text: "what's the weather like tomorrow?",
    view: "chat",
    stage1: {
      contexts: ["web", "general"],
      intents: ["report tomorrow's weather"],
      otherActionSelected: true,
    },
  },
  {
    id: "chat-2",
    group: "plain chat",
    text: "summarize what we talked about earlier",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["summarize the conversation so far"] },
  },
  {
    id: "chat-3",
    group: "plain chat",
    text: "help me plan a birthday dinner for six",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["suggest a dinner plan for six people"] },
  },
  {
    id: "multi-1",
    group: "multi-intent",
    text: "text Sam I'm running late and set an alarm for 6am",
    view: "chat",
    expect: ["sms_compose", "clock_handoff"],
    stage1: {
      contexts: ["messaging", "tasks"],
      intents: ["text Sam that the owner is running late", "set an alarm for 6:00"],
      otherActionSelected: true,
    },
  },
  {
    id: "multi-2",
    group: "multi-intent",
    text: "take a photo of the whiteboard and send it to Priya",
    view: "chat",
    expect: ["camera_capture_photo", "sms_compose"],
    stage1: {
      contexts: ["media", "messaging"],
      intents: ["take a photo", "send the photo to Priya"],
      otherActionSelected: true,
    },
  },
  {
    id: "multi-3",
    group: "multi-intent",
    text: "look up Luigi's on the web, then call them and add dinner at 8 to my phone calendar",
    view: "chat",
    expect: ["browser_search", "phone_call", "calendar_create_local"],
    stage1: {
      contexts: ["browser", "phone", "calendar"],
      intents: [
        "search the web for Luigi's",
        "call the restaurant",
        "create a phone calendar event for dinner at 8",
      ],
      otherActionSelected: true,
    },
  },
  {
    id: "vague-1",
    group: "names no operation",
    text: "can you do that on my phone?",
    view: "chat",
    expect: ["*"],
    stage1: { contexts: ["general"], intents: ["repeat the earlier request on the phone"] },
  },
  {
    id: "vague-2",
    group: "names no operation (follow-up)",
    text: "yes go ahead",
    view: "chat",
    recent: ["texts"],
    expect: ["sms_compose"],
    stage1: { contexts: ["general"], intents: ["proceed with the proposed step"] },
  },
  {
    id: "vague-3",
    group: "other language",
    text: "llama a mamá",
    view: "chat",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["call the owner's mother"] },
  },
  {
    id: "vague-4",
    group: "other script",
    text: "给妈妈打电话",
    view: "chat",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["call the owner's mother"] },
  },
  {
    id: "vague-5",
    group: "unsupported device request",
    text: "turn on the flashlight",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["turn on the phone flashlight"] },
  },
];

const HELD_OUT: readonly PhoneRequest[] = [
  {
    id: "h-call-1",
    group: "call",
    text: "facetime grandma",
    view: "chat",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["start a call with the owner's grandmother"] },
  },
  {
    id: "h-call-2",
    group: "call",
    text: "dial 911",
    view: "maps",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["call 911"] },
  },
  {
    id: "h-call-3",
    group: "call (vague)",
    text: "buzz Mike",
    view: "chat",
    expectAny: ["phone_call", "sms_compose"],
    stage1: { contexts: ["phone", "messaging"], intents: ["get in contact with Mike"] },
  },
  {
    id: "h-call-4",
    group: "call (vague)",
    text: "I should probably talk to my landlord today, can you get him for me",
    view: "notes",
    expect: ["phone_call"],
    stage1: { contexts: ["phone", "general"], intents: ["call the owner's landlord"] },
  },
  {
    id: "h-text-1",
    group: "text",
    text: "can u txt mom im omw",
    view: "chat",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["text the owner's mother that the owner is on the way"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-text-2",
    group: "text (vague)",
    text: "shoot Dana a quick line that I'm running behind",
    view: "calendar",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["message Dana that the owner is running behind"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-text-3",
    group: "text (vague)",
    text: "ask Lee if dinner still works",
    view: "chat",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging", "general"],
      intents: ["ask Lee whether dinner still works"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-text-4",
    group: "text (vague)",
    text: "hey can you hit Sam up about tomorrow",
    view: "maps",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["message Sam about tomorrow"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-text-5",
    group: "text",
    text: "what did Sam send me?",
    view: "chat",
    expectAny: ["messages_read_selected", "sms_latest_sender"],
    stage1: {
      contexts: ["messaging"],
      intents: ["read Sam's latest message"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-text-6",
    group: "text",
    text: "tell my wife I'll be home by six",
    view: "browser",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["text the owner's wife that the owner will be home by six"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-contact-1",
    group: "contact",
    text: "save this number as Plumber",
    view: "phone",
    expect: ["contact_create"],
    stage1: { contexts: ["contacts"], intents: ["create a contact named Plumber"] },
  },
  {
    id: "h-contact-2",
    group: "contact",
    text: "change Sam's email to sam@example.com",
    view: "chat",
    expect: ["contact_update"],
    stage1: { contexts: ["contacts"], intents: ["update Sam's email address"] },
  },
  {
    id: "h-contact-3",
    group: "contact (vague)",
    text: "put Jamie's digits in my phone",
    view: "chat",
    expect: ["contact_create"],
    stage1: { contexts: ["contacts"], intents: ["save Jamie's phone number as a contact"] },
  },
  {
    id: "h-contact-4",
    group: "contact",
    text: "do I have Dr. Okafor saved?",
    view: "maps",
    expect: ["contact_show"],
    stage1: { contexts: ["contacts"], intents: ["look up Dr. Okafor in the phone contacts"] },
  },
  {
    id: "h-keypad-1",
    group: "dialer/keypad",
    text: "pull up the number pad",
    view: "notes",
    expect: ["phone_keypad"],
    stage1: { contexts: ["phone"], intents: ["open the phone keypad"] },
  },
  {
    id: "h-camera-1",
    group: "camera",
    text: "grab a shot of the receipt",
    view: "chat",
    expect: ["camera_capture_photo"],
    stage1: {
      contexts: ["media"],
      intents: ["take a photo of the receipt"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-camera-2",
    group: "camera",
    text: "can you take my picture",
    view: "maps",
    expect: ["camera_capture_photo"],
    stage1: {
      contexts: ["media"],
      intents: ["take a photo of the owner"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-alarm-1",
    group: "alarm (vague)",
    text: "I need to be up by 5:30 tomorrow",
    view: "chat",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["set an alarm for 5:30 tomorrow"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-alarm-2",
    group: "alarm (vague)",
    text: "get me up at 6",
    view: "maps",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["set a 6:00 alarm"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-alarm-3",
    group: "alarm (vague)",
    text: "stop the ringing",
    view: "chat",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["dismiss the ringing alarm"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-alarm-4",
    group: "alarm",
    text: "show my alarms",
    view: "browser",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["show the alarms in Clock"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-reminder-1",
    group: "reminder",
    text: "nudge me at 5 to leave for the airport",
    view: "chat",
    expect: ["reminder_create"],
    stage1: {
      contexts: ["tasks"],
      intents: ["create a reminder at 5:00 to leave for the airport"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-calendar-1",
    group: "calendar (phone)",
    text: "book the dentist for Tuesday at 3 on my phone calendar",
    view: "chat",
    expect: ["calendar_create_local"],
    stage1: {
      contexts: ["calendar"],
      intents: ["create a phone calendar event for the dentist on Tuesday at 3"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-calendar-2",
    group: "calendar (phone)",
    text: "what's next today?",
    view: "chat",
    expect: ["calendar_read_next"],
    stage1: {
      contexts: ["calendar"],
      intents: ["read the next calendar event"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-files-1",
    group: "files",
    text: "where's my boarding pass pdf",
    view: "chat",
    expect: ["files_filter"],
    stage1: {
      contexts: ["files"],
      intents: ["find the boarding pass PDF in Files"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-browser-1",
    group: "browser",
    text: "pop open a private tab",
    view: "chat",
    expect: ["browser_tab_new"],
    stage1: {
      contexts: ["browser"],
      intents: ["open a private browser tab"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-browser-2",
    group: "browser",
    text: "find 'refund' on this page",
    view: "browser",
    expect: ["browser_find"],
    stage1: {
      contexts: ["browser"],
      intents: ["find the word refund on the open page"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-maps-1",
    group: "maps (not a device operation)",
    text: "any good coffee around here?",
    view: "maps",
    stage1: {
      contexts: ["maps", "general"],
      intents: ["find coffee shops nearby"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-chat-1",
    group: "plain chat",
    text: "translate 'where is the station' into Italian",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["translate a phrase into Italian"] },
  },
  {
    id: "h-chat-2",
    group: "plain chat",
    text: "how many days until March 3rd?",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["count the days until March 3rd"] },
  },
  {
    id: "h-multi-1",
    group: "multi-intent",
    text: "save Kim's number 415-555-0177 and then give her a ring",
    view: "chat",
    expect: ["contact_create", "phone_call"],
    stage1: {
      contexts: ["contacts", "phone"],
      intents: ["create a contact for Kim", "call Kim"],
    },
  },
  {
    id: "h-multi-2",
    group: "multi-intent",
    text: "snap the menu, then let the group know where we are",
    view: "maps",
    expect: ["camera_capture_photo", "sms_compose"],
    stage1: {
      contexts: ["media", "messaging"],
      intents: ["take a photo of the menu", "message the group the current location"],
      otherActionSelected: true,
    },
  },
  {
    id: "h-vague-1",
    group: "names no operation",
    text: "same thing for Friday",
    view: "chat",
    expect: ["*"],
    stage1: { contexts: ["general"], intents: ["repeat the previous request for Friday"] },
  },
];

const HELD_OUT_2: readonly PhoneRequest[] = [
  {
    id: "g-call-1",
    group: "call",
    text: "give the pharmacy a call",
    view: "chat",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["call the pharmacy"] },
  },
  {
    id: "g-call-2",
    group: "call (vague)",
    text: "I gotta talk to Jordan real quick",
    view: "maps",
    expect: ["phone_call"],
    stage1: { contexts: ["phone", "general"], intents: ["call Jordan"] },
  },
  {
    id: "g-call-3",
    group: "call (vague)",
    text: "can you get the office on speaker",
    view: "calendar",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["call the office"] },
  },
  {
    id: "g-text-1",
    group: "text",
    text: "message Priya happy birthday",
    view: "chat",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["send Priya a happy birthday message"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-text-2",
    group: "text",
    text: "tell the team I'm out sick today",
    view: "browser",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging"],
      intents: ["message the team that the owner is out sick today"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-text-3",
    group: "text (vague)",
    text: "write to Marco that the package arrived",
    view: "notes",
    expect: ["sms_compose"],
    stage1: {
      contexts: ["messaging", "general"],
      intents: ["tell Marco the package arrived"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-text-4",
    group: "text",
    text: "did anyone text me while I was driving?",
    view: "maps",
    expectAny: ["sms_latest_sender", "messages_read_selected"],
    stage1: {
      contexts: ["messaging"],
      intents: ["check for new incoming SMS"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-text-5",
    group: "text (open thread)",
    text: "answer her with 'on my way'",
    view: "messages",
    selectionKind: "thread",
    expect: ["sms_reply_selected"],
    stage1: {
      contexts: ["messaging"],
      intents: ["draft a reply saying on my way in the open conversation"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-contact-1",
    group: "contact",
    text: "look up Dana's cell",
    view: "chat",
    expect: ["contact_show"],
    stage1: { contexts: ["contacts"], intents: ["show Dana's mobile number"] },
  },
  {
    id: "g-contact-2",
    group: "contact",
    text: "new number for Chris: 415-555-0188",
    view: "phone",
    expect: ["contact_update"],
    stage1: { contexts: ["contacts"], intents: ["add a phone number to Chris's contact"] },
  },
  {
    id: "g-contact-3",
    group: "contact",
    text: "remove Tom from my contacts",
    view: "chat",
    expect: ["contact_delete"],
    stage1: { contexts: ["contacts"], intents: ["delete the contact Tom"] },
  },
  {
    id: "g-contact-4",
    group: "contact (vague)",
    text: "keep Dr. Reyes's info, it's 415-555-0142",
    view: "maps",
    expect: ["contact_create"],
    stage1: { contexts: ["contacts"], intents: ["save Dr. Reyes as a contact with a number"] },
  },
  {
    id: "g-keypad-1",
    group: "dialer/keypad",
    text: "bring up the dial pad",
    view: "browser",
    expect: ["phone_keypad"],
    stage1: { contexts: ["phone"], intents: ["open the phone keypad"] },
  },
  {
    id: "g-camera-1",
    group: "camera",
    text: "photo time, front camera please",
    view: "chat",
    expect: ["camera_capture_photo"],
    stage1: {
      contexts: ["media"],
      intents: ["take a photo with the front camera"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-camera-2",
    group: "camera (vague)",
    text: "capture what's on the whiteboard",
    view: "notes",
    expect: ["camera_capture_photo"],
    stage1: {
      contexts: ["media"],
      intents: ["take a photo of the whiteboard"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-alarm-1",
    group: "alarm",
    text: "alarm for half six",
    view: "chat",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["set an alarm for 6:30"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-alarm-2",
    group: "alarm (vague)",
    text: "don't let me oversleep tomorrow, 6:45",
    view: "maps",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["set an alarm for 6:45 tomorrow"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-alarm-3",
    group: "alarm",
    text: "turn off my 7am alarm",
    view: "chat",
    expect: ["clock_handoff"],
    stage1: {
      contexts: ["tasks"],
      intents: ["dismiss the 7:00 alarm"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-reminder-1",
    group: "reminder",
    text: "remind me about the dentist when I get to work tomorrow at 9",
    view: "chat",
    expect: ["reminder_create"],
    stage1: {
      contexts: ["tasks"],
      intents: ["create a reminder about the dentist tomorrow at 9:00"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-calendar-1",
    group: "calendar (phone)",
    text: "put a hold on my phone calendar for Thursday 2pm",
    view: "chat",
    expect: ["calendar_create_local"],
    stage1: {
      contexts: ["calendar"],
      intents: ["create a phone calendar event on Thursday at 2pm"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-calendar-2",
    group: "calendar (canonical store)",
    text: "do I have anything this afternoon?",
    view: "chat",
    stage1: {
      contexts: ["calendar"],
      intents: ["list this afternoon's calendar events"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-files-1",
    group: "files",
    text: "open my screenshots folder",
    view: "chat",
    expectAny: ["files_filter", "files_open"],
    stage1: {
      contexts: ["files"],
      intents: ["show the Screenshots folder in Files"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-files-2",
    group: "files (selected file)",
    text: "share that with myself",
    view: "files",
    selectionKind: "file",
    expect: ["files_share"],
    stage1: {
      contexts: ["files"],
      intents: ["share the selected file"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-browser-1",
    group: "browser",
    text: "google the opening hours for the DMV",
    view: "chat",
    expect: ["browser_search"],
    stage1: {
      contexts: ["browser", "web"],
      intents: ["search the web for DMV opening hours"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-browser-2",
    group: "browser",
    text: "switch to the tab with the recipe",
    view: "browser",
    expect: ["browser_tab_switch"],
    stage1: {
      contexts: ["browser"],
      intents: ["show the open tab with the recipe"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-maps-1",
    group: "maps (not a device operation)",
    text: "how long to drive to the coast?",
    view: "maps",
    stage1: {
      contexts: ["maps", "general"],
      intents: ["estimate the drive time to the coast"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-chat-1",
    group: "plain chat",
    text: "what's 18% of 240?",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["compute 18 percent of 240"] },
  },
  {
    id: "g-chat-2",
    group: "plain chat",
    text: "write me a haiku about rain",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["write a haiku about rain"] },
  },
  {
    id: "g-multi-1",
    group: "multi-intent",
    text: "call the vet, and remind me to pick up the meds at 5",
    view: "chat",
    expect: ["phone_call", "reminder_create"],
    stage1: {
      contexts: ["phone", "tasks"],
      intents: ["call the vet", "create a reminder at 5:00 to pick up the meds"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-multi-2",
    group: "multi-intent",
    text: "take a selfie and set my alarm for 7",
    view: "chat",
    expect: ["camera_capture_photo", "clock_handoff"],
    stage1: {
      contexts: ["media", "tasks"],
      intents: ["take a selfie", "set an alarm for 7:00"],
      otherActionSelected: true,
    },
  },
  {
    id: "g-vague-1",
    group: "names no operation (follow-up)",
    text: "do the same for my sister",
    view: "chat",
    recent: ["texts"],
    expect: ["sms_compose"],
    stage1: { contexts: ["general"], intents: ["repeat the previous step for the owner's sister"] },
  },
  {
    id: "g-vague-2",
    group: "other language",
    text: "appelle le médecin",
    view: "chat",
    expect: ["phone_call"],
    stage1: { contexts: ["phone"], intents: ["call the doctor"] },
  },
  {
    id: "g-vague-3",
    group: "unsupported device request",
    text: "lower the brightness",
    view: "chat",
    stage1: { contexts: ["general"], intents: ["lower the screen brightness"] },
  },
];

type Routing = "routed" | "misrouted" | "degraded" | "claimed";

/**
 * routed: the plausible first-stage routing written with each request.
 * misrouted: the first stage understood the request (intents kept) but picked
 *   an unrelated domain whose action was selected.
 * degraded: the first stage gave nothing (general only, no intents, no other
 *   action selected), so only the request text, view and selection are left.
 * claimed: no intents and an unrelated domain whose action was selected, so
 *   the whole-tool fallback cannot trigger and only the request text, view
 *   and selection protect the request.
 */
function evidenceFor(request: PhoneRequest, routing: Routing): Evidence {
  const understood = routing === "routed" || routing === "misrouted";
  return {
    text: request.text,
    view: request.view,
    selectionKind: request.selectionKind,
    recent: request.recent,
    intents: understood ? request.stage1.intents : [],
    contexts:
      routing === "routed"
        ? request.stage1.contexts
        : routing === "degraded"
          ? ["general"]
          : ["world"],
    otherActionSelected:
      routing === "routed"
        ? (request.stage1.otherActionSelected ?? false)
        : routing !== "degraded",
  };
}

const VARIANTS = {
  // As first measured on the first held-out set.
  v1: { core: false, viewClaims: true, intentsClaim: false },
  // The showing view no longer keeps a request off the whole tool.
  v2: { core: false, viewClaims: false, intentsClaim: false },
  // v2 plus the three operations that reach a person on every projected step.
  v2core: { core: true, viewClaims: false, intentsClaim: false },
  // v2core, and a request the first stage described without naming a device
  // operation is not sent the whole tool.
  v2lean: { core: true, viewClaims: false, intentsClaim: true },
} as const satisfies Record<string, Variant>;
const ROUTINGS = ["routed", "misrouted", "degraded", "claimed"] as const;

it("projects the device tool per request and measures it", () => {
  const full = toolSize(phoneTool);
  const sizes = new Map<string, ReturnType<typeof toolSize>>();
  const sizeOf = (types: readonly string[], style?: IndexStyle) => {
    const key = `${style ?? ""}:${types.join(",")}`;
    let size = sizes.get(key);
    if (!size) {
      size = toolSize(projectDeviceTool(new Set(types), style));
      sizes.set(key, size);
    }
    return size;
  };

  // Loading every operation is the unprojected tool, byte for byte.
  expect(
    JSON.stringify(actionToTool(projectDeviceTool(new Set(phoneTypes)) as never)),
  ).toBe(JSON.stringify(actionToTool(phoneTool as never)));
  // A projection offers only the loaded operations and the load branch, and
  // its index names every operation it hides.
  for (const family of phoneFamilies) {
    const loaded = typesOfFamily(family);
    const projected = projectDeviceTool(new Set(loaded));
    expect(
      operationBranches(projected)
        .map(branchType)
        .every((type) => type === LOAD_OPERATION || loaded.includes(type)),
    ).toBe(true);
    for (const type of phoneTypes)
      if (!loaded.includes(type)) expect(projected.description).toContain(type);
  }

  const none = deviceActionForCapabilities(
    withBranches(proposeDeviceAction, () => false),
    CAPABILITIES,
  );
  const familyRows = phoneFamilies.map((family) => {
    const branches = operationBranches(phoneTool).filter(
      (branch) => familyOf(branchType(branch)) === family,
    );
    const scoped = deviceActionForCapabilities(
      withBranches(proposeDeviceAction, (type) => familyOf(type) === family),
      CAPABILITIES,
    );
    return {
      family,
      operations: typesOfFamily(family).length,
      branches: branches.length,
      schemaChars: branches.reduce(
        (sum, branch) => sum + JSON.stringify(branch).length,
        0,
      ),
      guidanceChars: scoped.description.length - none.description.length,
      aloneChars: sizeOf(typesOfFamily(family)).chars,
      aloneTokens: sizeOf(typesOfFamily(family)).tokens,
    };
  });

  const run = (
    requests: readonly PhoneRequest[],
    routing: Routing,
    variant: Variant,
  ) =>
    requests.map((request) => {
      let decision = decideProjection(evidenceFor(request, routing), variant);
      if (
        decision.mode === "projected" &&
        sizeOf(decision.types).chars >= FULL_SHARE * full.chars
      )
        decision = {
          mode: "full",
          types: [],
          reason: "projection keeps most of the tool",
        };
      const size = decision.mode === "full" ? full : sizeOf(decision.types);
      const offered = new Set(
        decision.mode === "full" ? phoneTypes : decision.types,
      );
      const needed = request.expect ?? request.expectAny ?? [];
      const exposed =
        needed.length === 0
          ? null
          : needed.includes("*")
            ? decision.mode === "full"
            : request.expect
              ? request.expect.every((type) => offered.has(type))
              : (request.expectAny ?? []).some((type) => offered.has(type));
      // The step after a load request: what was loaded plus the missing families.
      const afterLoad =
        exposed === false
          ? needed.includes("*")
            ? full
            : sizeOf(
                phoneTypes.filter(
                  (type) =>
                    decision.types.includes(type) ||
                    needed.some((need) => familyOf(need) === familyOf(type)),
                ),
              )
          : undefined;
      const families = phoneFamilies.filter((family) =>
        typesOfFamily(family).every((type) => decision.types.includes(type)),
      );
      return {
        id: request.id,
        group: request.group,
        text: request.text,
        view: request.view,
        needs: needed.join(request.expect ? " + " : " | ") || "none",
        mode: decision.mode,
        reason: decision.reason,
        families: families.join(","),
        loose: decision.types
          .filter((type) => !families.includes(familyOf(type)))
          .join(","),
        chars: size.chars,
        tokens: size.tokens,
        exposed,
        afterLoadChars: afterLoad?.chars,
        afterLoadTokens: afterLoad?.tokens,
      };
    });
  const summarize = (rows: ReturnType<typeof run>) => {
    const device = rows.filter((row) => row.exposed !== null);
    const fullRows = rows.filter((row) => row.mode === "full");
    const projected = rows.filter((row) => row.mode === "projected");
    const mean = (values: number[]) =>
      values.length
        ? Math.round(
            values.reduce((sum, value) => sum + value, 0) / values.length,
          )
        : 0;
    return {
      requests: rows.length,
      fullFallback: fullRows.length,
      fullFallbackReasons: Object.fromEntries(
        [...new Set(fullRows.map((row) => row.reason))].map((reason) => [
          reason,
          fullRows.filter((row) => row.reason === reason).length,
        ]),
      ),
      deviceRequests: device.length,
      neededOperationHidden: device.filter((row) => row.exposed === false)
        .length,
      hiddenIds: device
        .filter((row) => row.exposed === false)
        .map((row) => row.id),
      meanChars: mean(rows.map((row) => row.chars)),
      meanTokens: mean(rows.map((row) => row.tokens)),
      medianChars: [...rows].sort((a, b) => a.chars - b.chars)[
        Math.floor(rows.length / 2)
      ].chars,
      meanCharsProjected: mean(projected.map((row) => row.chars)),
      // First step plus the widened tool on the step after a load request.
      meanCharsWithLoadStep: mean(
        rows.map((row) => row.chars + (row.afterLoadChars ?? 0)),
      ),
      meanTokensWithLoadStep: mean(
        rows.map((row) => row.tokens + (row.afterLoadTokens ?? 0)),
      ),
    };
  };
  const sets = {
    tuning: TUNING,
    heldOut1: HELD_OUT,
    heldOut2: HELD_OUT_2,
    all: [...TUNING, ...HELD_OUT, ...HELD_OUT_2],
  } as const;
  const runs: Record<
    string,
    Record<
      string,
      Record<
        string,
        { summary: ReturnType<typeof summarize>; rows: ReturnType<typeof run> }
      >
    >
  > = {};
  for (const [variantName, variant] of Object.entries(VARIANTS)) {
    runs[variantName] = {};
    for (const [setName, requests] of Object.entries(sets)) {
      runs[variantName][setName] = {};
      for (const routing of ROUTINGS) {
        const rows = run(requests, routing, variant);
        runs[variantName][setName][routing] = {
          summary: summarize(rows),
          rows: setName === "all" ? [] : rows,
        };
      }
    }
  }

  // Calls, texts, contacts, the keypad, the camera and alarms written the way
  // the routing fixes cover them stay reachable on the first planner step
  // from any view with no help from the first stage.
  const mustStayReachable = /^(?:call|text|contact|keypad|camera|alarm)-/;
  for (const variant of Object.keys(VARIANTS))
    for (const routing of ["degraded", "claimed"] as const)
      for (const row of runs[variant].tuning[routing].rows)
        if (mustStayReachable.test(row.id))
          expect(`${variant}:${routing}:${row.id}:${row.exposed}`).toBe(
            `${variant}:${routing}:${row.id}:true`,
          );

  const result = {
    capabilities: CAPABILITIES.length,
    full,
    indexOnly: {
      labelled: sizeOf([]),
      names: sizeOf([], "names"),
      labels: sizeOf([], "labels"),
    },
    reachAPerson: sizeOf(REACH_A_PERSON),
    untypedGuidanceChars: none.description.length,
    familyRows,
    runs,
    indexOnlyTool: actionToTool(projectDeviceTool(new Set()) as never),
    reachAPersonTool: actionToTool(
      projectDeviceTool(new Set(REACH_A_PERSON)) as never,
    ),
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
});
