/** Local measurement only (not committed): per-family device tools projected from PROPOSE_DEVICE_ACTION. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Action, ActionParameterSchema } from "@elizaos/core";
import { actionToTool } from "@elizaos/core";
import { expect, it } from "vitest";
import { buildActionCatalog } from "../runtime/action-catalog";
import { retrieveActions } from "../runtime/action-retrieval";
import {
  deviceActionForCapabilities,
  proposeDeviceAction,
} from "../services/device-actions/action";
import { authoredBrowserDestination } from "../services/device-actions/browser-request-grounding";
import { authoredCameraCapture } from "../services/device-actions/camera-request";
import { DEVICE_RECORD_ADMISSION } from "../services/device-actions/service";
import {
  authoredKeypadRequest,
  authoredTelephonyRequest,
} from "../services/device-actions/telephony-request";
import { deviceActionTools } from "../services/device-actions/tools";

const CAPABILITIES = JSON.parse(process.env.CTX_CAPABILITIES ?? "[]") as string[];
const OUT = process.env.CTX_TOOLS_OUT;
/** Optional exported room (private; only counts leave this file). */
const ROOM = process.env.CTX_ROOM_MESSAGES;

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
// Projection: one table assigns every operation type to a family. A family
// tool offers the family's operations that have no single-operation tool.
// ---------------------------------------------------------------------------

type Family = {
  name: string;
  /** An existing single-operation tool this entry selects instead of projecting a new one. */
  existing?: true;
  owns: (type: string) => boolean;
  /** Declared contexts (gate and discovery scope). */
  contexts: readonly string[];
  /** Stage-1 contexts that load the family without other evidence. */
  loadedByContexts: readonly string[];
  /** Phone views whose open screen is this family's target. */
  views: readonly string[];
  summary: string;
  similes: readonly string[];
  lead: string;
  /** Request words that load the family; matched on the message and the Stage-1 intents. */
  cues: RegExp;
};

const TELEPHONY_TYPES = new Set([
  "phone_call",
  "phone_dial",
  "phone_keypad",
  "sms_send",
  "sms_compose",
  "sms_reply_selected",
  "sms_latest_sender",
  "messages_read_selected",
  "voicemail_read_selected",
  "voicemail_delete_selected",
]);

const WORD = (alternatives: string) =>
  new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:${alternatives})(?=$|[^\p{L}\p{N}])`, "iu");

const FAMILIES: readonly Family[] = [
  {
    name: "DEVICE_CALLS_TEXTS",
    owns: (type) => TELEPHONY_TYPES.has(type),
    contexts: ["phone", "messaging", "general"],
    loadedByContexts: ["phone", "messaging"],
    views: ["phone", "messages"],
    summary:
      "This phone's own Phone and Messages apps, owner-reviewed: call a number or contact (phone_call), open the dialer keypad (phone_keypad), text or draft an SMS (sms_compose), reply in the open thread, read the open thread or voicemail, latest SMS sender.",
    similes: ["PHONE_CALL", "SEND_SMS", "TEXT_MESSAGE", "DIALER", "KEYPAD", "VOICEMAIL"],
    lead: "Calls and texts through this phone's own Phone and Messages apps.",
    cues: WORD(
      "calls?|calling|called|ring|rings|dial(?:s|er|ing)?|dial ?pad|key ?pad|number pad|texts?|texting|texted|sms|message|messages|messaged|messaging|msg|ping|hit up|reach out|voicemails?|let (?:\\p{L}+ ){1,3}know|tell (?:\\p{L}+ ){1,2}(?:that|i|i'm|im|we)|reply|respond",
    ),
  },
  {
    name: "DEVICE_CONTACTS",
    owns: (type) => type.startsWith("contact_"),
    contexts: ["contacts", "general"],
    loadedByContexts: ["contacts"],
    views: ["contacts"],
    summary:
      "This phone's address book, owner-reviewed: add, change or delete a contact (contact_create, contact_update, contact_delete), show a named contact or its number (contact_show), read the open contact.",
    similes: ["ADD_CONTACT", "SAVE_CONTACT", "EDIT_CONTACT", "DELETE_CONTACT", "SHOW_CONTACT", "ADDRESS_BOOK"],
    lead: "The address book of this phone's own Contacts app.",
    cues: WORD(
      "contacts|(?:a|the|new|this|that|my|his|her|their|phone) contact|contact (?:card|info|details|entry|for|named|called)|address book|(?:phone )?number (?:for|of)|(?:'s|s) (?:phone |cell |mobile )?number|(?:'s|s) (?:email|e-mail)(?: address)?|(?:his|her|their) (?:card|number)|save (?:this |that |the |his |her |their )?number|save \\+?[\\d(][\\d\\s().-]{5,}\\d",
    ),
  },
  {
    name: "DEVICE_CLOCK",
    owns: (type) => type.startsWith("clock_"),
    contexts: ["tasks", "automation", "general"],
    loadedByContexts: [],
    views: ["clock"],
    summary:
      "This phone's Clock, owner-reviewed: set an alarm that rings, show alarms, dismiss or snooze an alarm (clock_handoff, clock_alarm).",
    similes: ["SET_ALARM", "ADD_ALARM", "CREATE_ALARM", "WAKE_ME_UP", "SNOOZE_ALARM", "DISMISS_ALARM"],
    lead: "Alarms in this phone's Clock.",
    cues: WORD("alarms?|wake (?:me|us|him|her)(?: up)?|wake-?up|snooze|clock"),
  },
  {
    name: "DEVICE_FILES",
    owns: (type) => type.startsWith("files_"),
    contexts: ["files", "documents", "general"],
    loadedByContexts: ["files"],
    views: ["files"],
    summary:
      "This phone's Files app: filter, open, share, move or trash a file, create a folder (files_filter, files_open, files_share, files_move, files_trash, files_folder_create).",
    similes: ["FILE_BROWSER", "OPEN_FILE", "SHARE_FILE", "MOVE_FILE", "DELETE_FILE", "CREATE_FOLDER"],
    lead: "Files in this phone's Files app.",
    cues: WORD("files?|folders?|downloads?|documents? folder|pdfs?|storage"),
  },
  {
    name: "DEVICE_BROWSER_CONTROL",
    owns: (type) => type.startsWith("browser_") && type !== "browser_navigate",
    contexts: ["browser", "web", "general"],
    loadedByContexts: ["browser"],
    views: ["browser"],
    summary:
      "This phone's Browser: web search (browser_search), open, switch or close a tab, find text on the page, back, forward, reload or stop.",
    similes: ["WEB_SEARCH_ON_PHONE", "NEW_TAB", "CLOSE_TAB", "SWITCH_TAB", "FIND_ON_PAGE", "BROWSER_BACK"],
    lead: "Controls for this phone's Browser.",
    cues: WORD(
      "tabs?|google|search (?:the web|online)|web search|look (?:it|this|that) up|find on (?:the |this )?page|on (?:the|this) page|go back|go forward|reload|refresh|private tab|incognito",
    ),
  },
  {
    name: "DEVICE_CAMERA_CAPTURE",
    existing: true,
    owns: (type) => type === "camera_capture_photo",
    contexts: ["media", "general"],
    loadedByContexts: [],
    views: ["camera"],
    summary: "",
    similes: [],
    lead: "",
    cues: WORD("pictures?|photos?|photographs?|pics?|selfies?|snapshots?|camera"),
  },
  {
    name: "DEVICE_BROWSER_OPEN",
    existing: true,
    owns: (type) => type === "browser_navigate",
    contexts: ["browser", "web", "general"],
    loadedByContexts: [],
    views: [],
    summary: "",
    similes: [],
    lead: "",
    // Stands in for containsWebAddress on the owner's words.
    cues: /(?:^|\s)(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|co|gov|edu)(?:\/\S*)?(?=$|[\s.,!?])/iu,
  },
  {
    name: "DEVICE_RECORD_REVIEW",
    owns: (type) =>
      type.startsWith("calendar_") ||
      type.startsWith("notes_") ||
      type.startsWith("reminder_") ||
      type === "create_note" ||
      type === "create_reminder",
    contexts: ["calendar", "notes", "general"],
    loadedByContexts: [],
    views: [],
    summary:
      "Phone-native Calendar and Notes reviews with no tool of their own: free/busy on the phone calendar (calendar_availability), change or delete a phone event or note by name (calendar_named, notes_named), search phone notes, delete the selected phone event or note.",
    similes: ["PHONE_CALENDAR_AVAILABILITY", "FREE_BUSY", "PHONE_NOTES_SEARCH"],
    lead: "Phone-native Calendar and Notes reviews.",
    cues: WORD(
      "am i (?:free|busy|available)|are we free|free(?:/| or )busy|availability|phone(?:'s)? (?:own )?(?:calendar|notes)|(?:calendar|notes) on (?:this|my|the) phone",
    ),
  },
];

const UNTYPED_GUIDANCE = [
  "Propose an approved selected Maps snapshot, note, reminder, view change, or HTTPS browser navigation on the phone enrolled for this authenticated turn. Browser navigation is only for a web address the user typed in this message and asks to open now; never for a deferred, hypothetical, question-about, past or reported mention.",
  "The phone owner must explicitly review and approve, except that a typed address the user asks to open now may open without a review.",
];
const FAMILY_LEAD_TAIL =
  " The owner reviews each operation on the phone unless its rule says it runs directly; a proposal is never completion.";

const branchTypes = (branch: ActionParameterSchema): string[] =>
  (branch.properties?.type?.enum ?? []).filter(
    (value): value is string => typeof value === "string",
  );

function umbrellaWith(
  keep: (type: string) => boolean,
  capabilities: readonly string[],
): Action {
  return deviceActionForCapabilities(
    {
      ...proposeDeviceAction,
      parameters: proposeDeviceAction.parameters?.map((parameter) =>
        parameter.name === "operation"
          ? {
              ...parameter,
              schema: {
                ...parameter.schema,
                anyOf: parameter.schema.anyOf?.filter((branch) =>
                  branchTypes(branch).every(keep),
                ),
              },
            }
          : parameter,
      ),
    },
    capabilities,
  );
}

const operationBranches = (action: Action): ActionParameterSchema[] =>
  action.parameters?.find((parameter) => parameter.name === "operation")?.schema
    .anyOf ?? [];

const SINGLE_OPERATION_TOOLS = new Map<string, string>();
for (const tool of deviceActionTools) {
  const [type] = new Set(operationBranches(tool).flatMap(branchTypes));
  if (type) SINGLE_OPERATION_TOOLS.set(type, tool.name);
}

/** Record admission of an ordinary turn: canonical Notes/Calendar/reminder stores, nothing selected. */
function ordinaryTurnAdmits(type: string, view: string): boolean {
  if (type.startsWith("reminder_") || type === "create_reminder") return false;
  const rule = Object.hasOwn(DEVICE_RECORD_ADMISSION, type)
    ? DEVICE_RECORD_ADMISSION[type]
    : undefined;
  if (!rule) return true;
  if (rule.selection !== "none" || type === "calendar_create_local") return false;
  return rule.views === "any" || rule.views.includes(view);
}

function familyTool(
  family: Family,
  capabilities: readonly string[],
  admits: (type: string) => boolean = () => true,
): Action | undefined {
  const scoped = umbrellaWith(
    (type) =>
      family.owns(type) && !SINGLE_OPERATION_TOOLS.has(type) && admits(type),
    capabilities,
  );
  if (operationBranches(scoped).length === 0) return undefined;
  let guidance = scoped.description;
  for (const sentence of UNTYPED_GUIDANCE)
    guidance = guidance.replace(sentence, "").replace(/ {2,}/g, " ").trim();
  return {
    ...scoped,
    name: family.name,
    description: `${family.lead}${FAMILY_LEAD_TAIL} ${guidance}`,
    descriptionCompressed: family.summary,
    similes: [...family.similes],
    contexts: [...family.contexts],
    parameters: scoped.parameters?.map((parameter) =>
      parameter.name === "operation"
        ? { ...parameter, description: "Exact typed operation to show for approval" }
        : parameter,
    ),
    // The umbrella handler runs the operation unchanged once the type is one this tool offers.
    handler: async (runtime, message, state, options, ...rest) => {
      const type = (
        options?.parameters as { operation?: { type?: unknown } } | undefined
      )?.operation?.type;
      if (typeof type !== "string" || !family.owns(type))
        return {
          success: false,
          text: "This action does not authorize that device operation.",
          data: { code: "DEVICE_OPERATION_SCOPE" },
        };
      return proposeDeviceAction.handler(runtime, message, state, options, ...rest);
    },
  };
}

const toolJson = (action: Action): string => JSON.stringify(actionToTool(action));

// ---------------------------------------------------------------------------
// Selection: routing rules, Stage-1 contexts, request and intent words, the
// open phone view, and the family of the previous turn for a follow-up.
// ---------------------------------------------------------------------------

type Request = {
  id: string;
  text: string;
  view: string;
  /** Plausible Stage-1 contexts for the request. */
  contexts: readonly string[];
  /** A Stage-1 routing that does not name the owning domain. */
  wrongContexts: readonly string[];
  /** Plausible Stage-1 intents (model-authored on a real turn). */
  intents: readonly string[];
  /** Device family of the previous turn, for a referential follow-up. */
  previousFamily?: string;
  /** Device tools the request needs: a family tool, a single-operation tool, or none. */
  needs: readonly string[];
  operation: string;
};

const FOLLOW_UP =
  /^(?:(?:ok(?:ay)?|yes|yeah|yep|sure|no|actually)[,.!]?\s+)?(?:(?:and|also|then)\s+)?(?:(?:do|send|make|change|try|use|call|text|set|delete|open|read|close)\s+)?(?:it|that|this|them|him|her|the same|again|instead|one more)\b|^(?:yes|yeah|yep|ok(?:ay)?|sure|go ahead|do it|send it|make it \S+)[.!]?$/iu;

type Selection = { names: string[]; why: Record<string, string[]> };

/** Strongest evidence first; the cap drops the weakest. */
const EVIDENCE = ["rule", "words", "intent", "context", "follow-up", "view"];
const MAX_SELECTED = 3;

function selectFamilies(
  request: Request,
  input: { contexts: readonly string[]; intents: readonly string[] },
  offered: ReadonlySet<string>,
): Selection {
  const why: Record<string, string[]> = {};
  const add = (name: string, reason: string) => {
    if (!offered.has(name)) return;
    why[name] = [...(why[name] ?? []), reason];
  };
  // The strict whole-message routes registered today.
  if (authoredTelephonyRequest(request.text) || authoredKeypadRequest(request.text))
    add("DEVICE_CALLS_TEXTS", "rule");
  if (authoredCameraCapture(request.text)) add("DEVICE_CAMERA_CAPTURE", "rule");
  if (authoredBrowserDestination(request.text)) add("DEVICE_BROWSER_OPEN", "rule");
  for (const family of FAMILIES) {
    if (family.loadedByContexts.some((context) => input.contexts.includes(context)))
      add(family.name, "context");
    if (family.cues.test(request.text)) add(family.name, "words");
    else if (input.intents.some((intent) => family.cues.test(intent)))
      add(family.name, "intent");
    if (family.views.includes(request.view)) add(family.name, "view");
  }
  if (
    request.previousFamily &&
    Object.keys(why).length === 0 &&
    FOLLOW_UP.test(request.text.trim())
  )
    add(request.previousFamily, "follow-up");
  const strength = (name: string) =>
    Math.min(...why[name].map((reason) => EVIDENCE.indexOf(reason)));
  const names = Object.keys(why)
    .sort((left, right) => strength(left) - strength(right) || left.localeCompare(right))
    .slice(0, MAX_SELECTED)
    .sort();
  return { names, why: Object.fromEntries(names.map((name) => [name, why[name]])) };
}

/** Today's pin: the umbrella is on the surface when a selected context is one it declares. */
const UMBRELLA_CONTEXTS = ["general", "contacts", "phone", "messaging"];
function umbrellaPinnedToday(request: Request, contexts: readonly string[]): boolean {
  return (
    contexts.some((context) => UMBRELLA_CONTEXTS.includes(context)) ||
    authoredTelephonyRequest(request.text) !== undefined ||
    authoredKeypadRequest(request.text) !== undefined
  );
}

/** Added to every domain tool on the wire: completion-context schema (889) and turn scope (92). */
const WIRE_OVERHEAD_PER_TOOL = 981;

const REQUESTS: readonly Request[] = [
  { id: "call-contact", text: "call mom", view: "home", contexts: ["phone"], wrongContexts: ["contacts"], intents: ["place a phone call to mom"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call" },
  { id: "call-number-maps", text: "can you call 415-555-0100", view: "maps", contexts: ["phone", "general"], wrongContexts: ["maps", "general"], intents: ["call the number 415-555-0100"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call" },
  { id: "call-vague", text: "give my sister a ring when you get a sec", view: "home", contexts: ["phone"], wrongContexts: ["general"], intents: ["call the user's sister"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call" },
  { id: "text-contact", text: "text Sam saying running ten minutes late", view: "home", contexts: ["messaging"], wrongContexts: ["general"], intents: ["send Sam a text that the user is running ten minutes late"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose" },
  { id: "text-vague-ping", text: "ping my brother", view: "home", contexts: ["messaging"], wrongContexts: ["general"], intents: ["contact the user's brother"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose | phone_call (planner asks which)" },
  { id: "text-vague-let-know", text: "let Dana know I'm outside", view: "maps", contexts: ["messaging", "general"], wrongContexts: ["maps"], intents: ["tell Dana that the user is outside"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose" },
  { id: "text-draft", text: "draft a message to the landlord about the broken heater, don't send it", view: "home", contexts: ["messaging"], wrongContexts: ["email"], intents: ["draft a text message to the landlord about the broken heater"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose draft" },
  { id: "reply-open-thread", text: "reply for me, say sounds good", view: "messages", contexts: ["messaging"], wrongContexts: ["general"], intents: ["draft a reply in the open conversation saying sounds good"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_reply_selected" },
  { id: "latest-sender", text: "who just texted me?", view: "home", contexts: ["messaging"], wrongContexts: ["general"], intents: ["find out who sent the latest text message"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_latest_sender" },
  { id: "keypad", text: "open the dialer", view: "home", contexts: ["phone", "general"], wrongContexts: ["general"], intents: ["open the phone keypad"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_keypad" },
  { id: "keypad-number", text: "bring up the keypad and type 415 302 4399", view: "browser", contexts: ["phone"], wrongContexts: ["browser", "general"], intents: ["open the phone keypad with 415 302 4399 filled in"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_keypad" },
  { id: "voicemail-read", text: "what does this voicemail say", view: "phone", contexts: ["phone"], wrongContexts: ["general"], intents: ["read the open voicemail"], needs: ["DEVICE_CALLS_TEXTS"], operation: "voicemail_read_selected" },
  { id: "contact-create", text: "add Priya Nair to my contacts, 628 555 0142", view: "home", contexts: ["contacts"], wrongContexts: ["general"], intents: ["create a phone contact for Priya Nair with the number 628 555 0142"], needs: ["DEVICE_CONTACTS"], operation: "contact_create" },
  { id: "contact-show", text: "what's Marco's number", view: "home", contexts: ["contacts"], wrongContexts: ["general"], intents: ["look up Marco's phone number"], needs: ["DEVICE_CONTACTS"], operation: "contact_show" },
  { id: "contact-update", text: "Jo got a new email, jo@example.org, add it to her card", view: "home", contexts: ["contacts"], wrongContexts: ["email"], intents: ["add the email jo@example.org to Jo's contact"], needs: ["DEVICE_CONTACTS"], operation: "contact_update" },
  { id: "contact-delete", text: "delete the contact for my old dentist", view: "contacts", contexts: ["contacts"], wrongContexts: ["general"], intents: ["delete the old dentist's contact"], needs: ["DEVICE_CONTACTS"], operation: "contact_delete" },
  { id: "alarm-set", text: "set an alarm for 6:30 tomorrow", view: "home", contexts: ["tasks"], wrongContexts: ["calendar"], intents: ["set an alarm for 6:30 tomorrow morning"], needs: ["DEVICE_CLOCK"], operation: "clock_handoff set" },
  { id: "alarm-vague", text: "wake me at 7", view: "home", contexts: ["tasks"], wrongContexts: ["general"], intents: ["set a 7:00 wake-up alarm"], needs: ["DEVICE_CLOCK"], operation: "clock_handoff set" },
  { id: "alarm-snooze-maps", text: "snooze it", view: "maps", contexts: ["tasks"], wrongContexts: ["maps", "general"], intents: ["snooze the ringing alarm"], needs: ["DEVICE_CLOCK"], operation: "clock_handoff snooze" },
  { id: "alarm-show", text: "show my alarms", view: "home", contexts: ["tasks", "general"], wrongContexts: ["general"], intents: ["show the phone's alarms"], needs: ["DEVICE_CLOCK"], operation: "clock_handoff show" },
  { id: "camera", text: "take a selfie", view: "home", contexts: ["media", "general"], wrongContexts: ["general"], intents: ["take a photo with the front camera"], needs: ["DEVICE_CAMERA_CAPTURE"], operation: "camera_capture_photo" },
  { id: "camera-vague", text: "grab a quick pic of this whiteboard", view: "notes", contexts: ["media"], wrongContexts: ["notes"], intents: ["take a photo of the whiteboard"], needs: ["DEVICE_CAMERA_CAPTURE"], operation: "camera_capture_photo" },
  { id: "files-share", text: "share the lease pdf from my downloads", view: "home", contexts: ["files"], wrongContexts: ["general"], intents: ["share the lease PDF file from Downloads"], needs: ["DEVICE_FILES"], operation: "files_filter + files_share" },
  { id: "files-deictic", text: "move this to Taxes", view: "files", contexts: ["files"], wrongContexts: ["general"], intents: ["move the selected file to the Taxes folder"], needs: ["DEVICE_FILES"], operation: "files_move" },
  { id: "browser-open", text: "open nytimes.com", view: "home", contexts: ["browser", "web", "general"], wrongContexts: ["general"], intents: ["open nytimes.com in the browser"], needs: ["DEVICE_BROWSER_OPEN"], operation: "browser_navigate" },
  { id: "browser-search", text: "google best ramen near union square", view: "home", contexts: ["browser", "web", "general"], wrongContexts: ["maps", "general"], intents: ["search the web for best ramen near union square"], needs: ["DEVICE_BROWSER_CONTROL"], operation: "browser_search" },
  { id: "browser-tab", text: "close this tab", view: "browser", contexts: ["browser"], wrongContexts: ["general"], intents: ["close the current browser tab"], needs: ["DEVICE_BROWSER_CONTROL"], operation: "browser_tab_close" },
  { id: "calendar-free", text: "am I free thursday afternoon?", view: "home", contexts: ["calendar"], wrongContexts: ["general"], intents: ["check the user's availability on Thursday afternoon"], needs: ["DEVICE_RECORD_REVIEW"], operation: "calendar_availability" },
  { id: "calendar-create", text: "put lunch with Ana on my calendar friday at noon", view: "home", contexts: ["calendar"], wrongContexts: ["general"], intents: ["create a calendar event: lunch with Ana, Friday 12:00"], needs: [], operation: "CALENDAR (canonical store)" },
  { id: "note-create", text: "jot down that the wifi password is on the fridge", view: "home", contexts: ["notes"], wrongContexts: ["general"], intents: ["save a note that the wifi password is on the fridge"], needs: [], operation: "NOTES (canonical store)" },
  { id: "reminder", text: "remind me to move the car in 40 minutes", view: "home", contexts: ["tasks"], wrongContexts: ["general"], intents: ["create a reminder in 40 minutes to move the car"], needs: [], operation: "OWNER_REMINDERS (canonical store)" },
  { id: "maps-route", text: "directions to the ferry building", view: "maps", contexts: ["maps", "general"], wrongContexts: ["general"], intents: ["get directions to the Ferry Building"], needs: [], operation: "MAPS_ROUTE" },
  { id: "chat", text: "why is the sky blue?", view: "home", contexts: ["general"], wrongContexts: ["general"], intents: ["explain why the sky is blue"], needs: [], operation: "REPLY" },
  { id: "chat-phone-words", text: "what was the first phone call ever made?", view: "home", contexts: ["general"], wrongContexts: ["knowledge"], intents: ["answer a history question about the first telephone call"], needs: [], operation: "REPLY" },
  { id: "multi-text-alarm", text: "text Lee I'm on my way and set an alarm for 5", view: "home", contexts: ["messaging", "tasks"], wrongContexts: ["general"], intents: ["send Lee a text saying the user is on the way", "set an alarm for 5:00"], needs: ["DEVICE_CALLS_TEXTS", "DEVICE_CLOCK"], operation: "sms_compose + clock_handoff" },
  { id: "multi-contact-call", text: "save 510 555 0199 as Plumber and then call him", view: "home", contexts: ["contacts", "phone"], wrongContexts: ["general"], intents: ["create a contact named Plumber with 510 555 0199", "call the plumber"], needs: ["DEVICE_CONTACTS", "DEVICE_CALLS_TEXTS"], operation: "contact_create + phone_call" },
  { id: "multi-note-photo", text: "take a picture of the receipt and remind me tomorrow to expense it", view: "home", contexts: ["media", "tasks"], wrongContexts: ["general"], intents: ["take a photo of the receipt", "create a reminder tomorrow to expense it"], needs: ["DEVICE_CAMERA_CAPTURE"], operation: "camera_capture_photo + OWNER_REMINDERS" },
  { id: "follow-up-call", text: "actually call him instead", view: "home", contexts: ["phone"], wrongContexts: ["general"], intents: ["call the person from the previous request instead of texting"], previousFamily: "DEVICE_CALLS_TEXTS", needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call" },
  { id: "follow-up-alarm", text: "make it 7:15", view: "home", contexts: ["tasks"], wrongContexts: ["general"], intents: ["change the previous alarm to 7:15"], previousFamily: "DEVICE_CLOCK", needs: ["DEVICE_CLOCK"], operation: "clock_handoff set" },
  { id: "hard-buzz", text: "buzz Tom", view: "home", contexts: ["general"], wrongContexts: ["general"], intents: ["get in touch with Tom"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call | sms_compose" },
  { id: "hard-up-by", text: "I need to be up by six", view: "home", contexts: ["general"], wrongContexts: ["general"], intents: ["make sure the user is up by 6:00"], needs: ["DEVICE_CLOCK"], operation: "clock_handoff set" },
];

/** Written after the cue lists were fixed and run once; never used to adjust them. */
const HELD_OUT: readonly Request[] = [
  { id: "h-ring", text: "hey can you ring the pharmacy for me", view: "home", contexts: ["phone"], wrongContexts: ["general"], intents: ["call the pharmacy"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call" },
  { id: "h-shoot-text", text: "shoot Maya a text that dinner's at 8", view: "home", contexts: ["messaging"], wrongContexts: ["general"], intents: ["send Maya a text saying dinner is at 8"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose" },
  { id: "h-message", text: "send a message to my landlord", view: "home", contexts: ["messaging"], wrongContexts: ["general"], intents: ["send a message to the user's landlord"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose" },
  { id: "h-tell", text: "tell Chris I'll be there in five", view: "maps", contexts: ["messaging"], wrongContexts: ["maps", "general"], intents: ["let Chris know the user arrives in five minutes"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose" },
  { id: "h-phone-verb", text: "phone the office", view: "home", contexts: ["phone"], wrongContexts: ["general"], intents: ["call the office"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call" },
  { id: "h-dial-number", text: "dial 1-800-555-0199", view: "home", contexts: ["phone"], wrongContexts: ["general"], intents: ["dial 1-800-555-0199"], needs: ["DEVICE_CALLS_TEXTS"], operation: "phone_call | phone_dial" },
  { id: "h-ask", text: "ask Priya if she's free for lunch", view: "home", contexts: ["messaging"], wrongContexts: ["general"], intents: ["send Priya a message asking if she is free for lunch"], needs: ["DEVICE_CALLS_TEXTS"], operation: "sms_compose" },
  { id: "h-read-last", text: "read me the last message from Jo", view: "messages", contexts: ["messaging"], wrongContexts: ["general"], intents: ["read the latest message from Jo"], needs: ["DEVICE_CALLS_TEXTS"], operation: "messages_read_selected" },
  { id: "h-number-for", text: "what's the number for the vet", view: "home", contexts: ["contacts"], wrongContexts: ["general"], intents: ["find the vet's phone number"], needs: ["DEVICE_CONTACTS"], operation: "contact_show" },
  { id: "h-new-contact", text: "new contact: Lina, 415 555 0111", view: "home", contexts: ["contacts"], wrongContexts: ["general"], intents: ["create a contact for Lina with 415 555 0111"], needs: ["DEVICE_CONTACTS"], operation: "contact_create" },
  { id: "h-update-cell", text: "update Sam's cell to 628 555 0100", view: "home", contexts: ["contacts"], wrongContexts: ["general"], intents: ["change Sam's phone number in his contact to 628 555 0100"], needs: ["DEVICE_CONTACTS"], operation: "contact_update" },
  { id: "h-get-me-up", text: "get me up at 5:45", view: "home", contexts: ["tasks"], wrongContexts: ["general"], intents: ["set an alarm for 5:45"], needs: ["DEVICE_CLOCK"], operation: "clock_handoff set" },
  { id: "h-cancel-alarm", text: "cancel my 7am alarm", view: "home", contexts: ["tasks"], wrongContexts: ["general"], intents: ["dismiss the 7:00 alarm"], needs: ["DEVICE_CLOCK"], operation: "clock_handoff dismiss" },
  { id: "h-alarm-off", text: "turn that off", view: "home", contexts: ["tasks"], wrongContexts: ["general"], intents: ["stop the ringing alarm"], previousFamily: "DEVICE_CLOCK", needs: ["DEVICE_CLOCK"], operation: "clock_handoff dismiss" },
  { id: "h-downloads", text: "search my downloads for the invoice", view: "home", contexts: ["files"], wrongContexts: ["general"], intents: ["find the invoice in Downloads"], needs: ["DEVICE_FILES"], operation: "files_filter" },
  { id: "h-folder", text: "make a folder called Receipts", view: "files", contexts: ["files"], wrongContexts: ["notes"], intents: ["create a folder named Receipts"], needs: ["DEVICE_FILES"], operation: "files_folder_create" },
  { id: "h-private-tab", text: "open a new private tab", view: "home", contexts: ["browser"], wrongContexts: ["general"], intents: ["open a private browser tab"], needs: ["DEVICE_BROWSER_CONTROL"], operation: "browser_tab_new" },
  { id: "h-look-up", text: "look up flights to Lisbon", view: "home", contexts: ["web", "general"], wrongContexts: ["general"], intents: ["search the web for flights to Lisbon"], needs: ["DEVICE_BROWSER_CONTROL"], operation: "browser_search" },
  { id: "h-snap", text: "snap a photo of this", view: "home", contexts: ["media"], wrongContexts: ["general"], intents: ["take a photo"], needs: ["DEVICE_CAMERA_CAPTURE"], operation: "camera_capture_photo" },
  { id: "h-go-back", text: "go back", view: "browser", contexts: ["browser"], wrongContexts: ["general"], intents: ["go back one page in the browser"], needs: ["DEVICE_BROWSER_CONTROL"], operation: "browser_history" },
];


it.skipIf(!CAPABILITIES.length)("measures per-family device tools", async () => {
  const umbrella = umbrellaWith(() => true, CAPABILITIES);
  const umbrellaChars = toolJson(umbrella).length;
  const umbrellaBranches = operationBranches(umbrella);
  const ordinaryUmbrella = (view: string) =>
    umbrellaWith((type) => ordinaryTurnAdmits(type, view), CAPABILITIES);
  const existingTool = (name: string) =>
    deviceActionForCapabilities(
      deviceActionTools.find((tool) => tool.name === name) as Action,
      CAPABILITIES,
    );
  const projected = FAMILIES.filter((family) => !family.existing);

  /** Device tools a turn can pin: projected families and the two existing phone-only tools. */
  const pinnable = (admits: (type: string) => boolean) =>
    new Map(
      FAMILIES.flatMap((family) => {
        const tool = family.existing
          ? umbrellaBranches.flatMap(branchTypes).some(family.owns)
            ? existingTool(family.name)
            : undefined
          : familyTool(family, CAPABILITIES, admits);
        return tool ? [[family.name, tool] as const] : [];
      }),
    );
  const fullFamilies = pinnable(() => true);

  // Every offered operation has exactly one narrow tool, or stays umbrella-only.
  const coverage = umbrellaBranches.flatMap(branchTypes).map((type) => ({
    type,
    tool:
      SINGLE_OPERATION_TOOLS.get(type) ??
      projected.find((family) => family.owns(type))?.name ??
      "PROPOSE_DEVICE_ACTION only",
  }));
  for (const family of projected) {
    const tool = fullFamilies.get(family.name);
    if (!tool) continue;
    const types = operationBranches(tool).flatMap(branchTypes);
    expect(types.every((type) => family.owns(type))).toBe(true);
    expect(types.some((type) => SINGLE_OPERATION_TOOLS.has(type))).toBe(false);
  }

  // A family call reaches the umbrella handler unchanged for its own operations
  // (which then requires the bound phone turn) and is refused for any other.
  const telephony = fullFamilies.get("DEVICE_CALLS_TEXTS") as Action;
  const call = (operation: unknown) =>
    telephony.handler?.({} as never, {} as never, undefined, {
      parameters: { operation, operationKey: "k1", reason: "test" },
    } as never);
  await expect(
    call({ type: "phone_call", target: { kind: "contact", query: "mom" } }),
  ).rejects.toThrow("No authenticated phone is bound to this turn");
  expect(await call({ type: "files_trash", ids: ["x"] })).toMatchObject({
    success: false,
    data: { code: "DEVICE_OPERATION_SCOPE" },
  });

  const row = (tool: Action) => {
    const json = toolJson(tool);
    return {
      name: tool.name,
      operations: [...new Set(operationBranches(tool).flatMap(branchTypes))],
      branches: operationBranches(tool).length,
      chars: json.length,
      tokens: estimateTokens(json),
      description: tool.description.length,
      schema: JSON.stringify(operationBranches(tool)).length,
    };
  };

  // Alternative considered: calls and texts as two tools.
  const split = [
    {
      ...FAMILIES[0],
      name: "DEVICE_CALLS",
      owns: (type: string) =>
        ["phone_call", "phone_dial", "phone_keypad", "voicemail_read_selected", "voicemail_delete_selected"].includes(type),
    },
    {
      ...FAMILIES[0],
      name: "DEVICE_TEXTS",
      owns: (type: string) =>
        ["sms_send", "sms_compose", "sms_reply_selected", "sms_latest_sender", "messages_read_selected"].includes(type),
    },
  ].map((family) => row(familyTool(family, CAPABILITIES) as Action));

  const singleRows = deviceActionTools
    .map((tool) => row(deviceActionForCapabilities(tool, CAPABILITIES)))
    .sort((left, right) => left.name.localeCompare(right.name));

  // What a query search over the device tools returns, for a missed selection.
  const discover = (query: string): string[] => {
    const catalog = buildActionCatalog(
      [...fullFamilies.values(), ...deviceActionTools]
        .filter((action, index, all) => all.findIndex((other) => other.name === action.name) === index)
        .map((action) => ({ ...action, subActions: undefined })),
    );
    return retrieveActions({ catalog, messageText: query })
      .results.filter((result) => result.score > 0)
      .slice(0, 3)
      .map((result) => `${result.name}:${result.score.toFixed(2)}`);
  };

  const conditions = [
    { key: "plausible", contexts: (r: Request) => r.contexts, intents: (r: Request) => r.intents },
    { key: "wrongContext", contexts: (r: Request) => r.wrongContexts, intents: (r: Request) => r.intents },
    { key: "wrongContextNoIntents", contexts: (r: Request) => r.wrongContexts, intents: () => [] as string[] },
  ] as const;

  const evaluate = (requests: readonly Request[]) => requests.map((request) => {
    const offered = pinnable((type) => ordinaryTurnAdmits(type, request.view));
    const ordinary = toolJson(ordinaryUmbrella(request.view)).length;
    const perCondition = Object.fromEntries(
      conditions.map((condition) => {
        const contexts = condition.contexts(request);
        const selection = selectFamilies(
          request,
          { contexts, intents: condition.intents(request) },
          new Set(offered.keys()),
        );
        const afterChars = selection.names.reduce(
          (sum, name) => sum + toolJson(offered.get(name) as Action).length,
          0,
        );
        const pinned = umbrellaPinnedToday(request, contexts);
        return [
          condition.key,
          {
            contexts,
            selected: selection.names,
            why: selection.why,
            afterChars,
            afterWire: afterChars + selection.names.length * WIRE_OVERHEAD_PER_TOOL,
            beforeUnbound: pinned ? umbrellaChars : 0,
            beforeOrdinary: pinned ? ordinary : 0,
            beforeOrdinaryWire: pinned ? ordinary + WIRE_OVERHEAD_PER_TOOL : 0,
            umbrellaPinnedToday: pinned,
            missing: request.needs.filter((name) => !selection.names.includes(name)),
            extra: selection.names.filter((name) => !request.needs.includes(name)),
          },
        ];
      }),
    );
    return {
      id: request.id,
      text: request.text,
      view: request.view,
      needs: request.needs,
      operation: request.operation,
      discovery: request.needs.length ? discover(request.text) : [],
      ...perCondition,
    };
  });
  const requestRows = evaluate(REQUESTS);
  const heldOutRows = evaluate(HELD_OUT);

  const summarize = (requestRows: ReturnType<typeof evaluate>) => Object.fromEntries(
    conditions.map((condition) => {
      const rows = requestRows.map(
        (entry) => (entry as unknown as Record<string, Record<string, unknown>>)[condition.key],
      );
      const device = requestRows.filter((entry) => entry.needs.length > 0);
      const deviceRows = device.map(
        (entry) => (entry as unknown as Record<string, Record<string, unknown>>)[condition.key],
      );
      const mean = (values: number[]) =>
        Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
      return [
        condition.key,
        {
          requests: rows.length,
          deviceRequests: device.length,
          familyComplete: deviceRows.filter((entry) => (entry.missing as string[]).length === 0).length,
          umbrellaOnSurfaceToday: deviceRows.filter((entry) => entry.umbrellaPinnedToday).length,
          requestsWithExtraTool: rows.filter((entry) => (entry.extra as string[]).length > 0).length,
          meanAfterChars: mean(rows.map((entry) => entry.afterChars as number)),
          meanAfterWire: mean(rows.map((entry) => entry.afterWire as number)),
          meanBeforeUnbound: mean(rows.map((entry) => entry.beforeUnbound as number)),
          meanBeforeOrdinary: mean(rows.map((entry) => entry.beforeOrdinary as number)),
          meanBeforeOrdinaryWire: mean(rows.map((entry) => entry.beforeOrdinaryWire as number)),
        },
      ];
    }),
  );
  const summary = summarize(requestRows);
  const heldOutSummary = summarize(heldOutRows);

  // Replay of a real phone room: the owner's words and open view only (no
  // Stage-1 contexts or intents), against the device operations that turn ran.
  const traffic = (() => {
    if (!ROOM || !existsSync(ROOM)) return undefined;
    const rows = JSON.parse(readFileSync(ROOM, "utf8")) as Array<{
      entityId: string;
      agentId: string;
      content: {
        text?: string;
        metadata?: { uiView?: string };
        chatIdempotency?: { outcomeJson?: string };
      };
    }>;
    const turns = rows.filter((entry) => entry.entityId !== entry.agentId);
    const familyOf = (type: string) =>
      SINGLE_OPERATION_TOOLS.get(type) ??
      projected.find((family) => family.owns(type))?.name ??
      "PROPOSE_DEVICE_ACTION";
    let previousFamily: string | undefined;
    const selectedCounts: Record<string, number> = {};
    const bySignal: Record<string, number> = {};
    const called: Record<string, { calls: number; loaded: number; signals: Record<string, number> }> = {};
    const missedLengths: number[] = [];
    let loadedTurns = 0;
    let plannerTurns = 0;
    let plannerLoadedTurns = 0;
    let loadedChars = 0;
    let toolsLoaded = 0;
    let loadedWithoutViewTurns = 0;
    let plannerLoadedChars = 0;
    for (const turn of turns) {
      const view = turn.content.metadata?.uiView === "chat" ? "home" : (turn.content.metadata?.uiView ?? "home");
      const offered = pinnable((type) => ordinaryTurnAdmits(type, view));
      const text = turn.content.text ?? "";
      const selection = selectFamilies(
        { id: "", text, view, contexts: [], wrongContexts: [], intents: [], previousFamily, needs: [], operation: "" },
        { contexts: [], intents: [] },
        new Set(offered.keys()),
      );
      let outcome: {
        usage?: { llmCalls?: number };
        actionResults?: Array<{ actionName?: string; effectReceipts?: Array<{ operation?: string }> }>;
      } = {};
      try {
        outcome = JSON.parse(turn.content.chatIdempotency?.outcomeJson ?? "{}");
      } catch {
        outcome = {};
      }
      const planner = (outcome.actionResults?.length ?? 0) > 0 || (outcome.usage?.llmCalls ?? 0) > 1;
      if (planner) plannerTurns += 1;
      if (selection.names.length) {
        loadedTurns += 1;
        if (planner) plannerLoadedTurns += 1;
        toolsLoaded += selection.names.length;
        const chars = selection.names.reduce(
          (sum, name) => sum + toolJson(offered.get(name) as Action).length + WIRE_OVERHEAD_PER_TOOL,
          0,
        );
        loadedChars += chars;
        if (planner) plannerLoadedChars += chars;
        if (selection.names.some((name) => selection.why[name].some((reason) => reason !== "view")))
          loadedWithoutViewTurns += 1;
        for (const name of selection.names) {
          selectedCounts[name] = (selectedCounts[name] ?? 0) + 1;
          const strongest = [...selection.why[name]].sort(
            (left, right) => EVIDENCE.indexOf(left) - EVIDENCE.indexOf(right),
          )[0];
          bySignal[strongest] = (bySignal[strongest] ?? 0) + 1;
        }
      }
      const operations = (outcome.actionResults ?? [])
        .filter((result) => result.actionName === "PROPOSE_DEVICE_ACTION")
        .flatMap((result) => result.effectReceipts ?? [])
        .flatMap((receipt) =>
          typeof receipt.operation === "string" && receipt.operation.startsWith("device.")
            ? [receipt.operation.slice(7)]
            : [],
        );
      for (const type of operations) {
        const family = familyOf(type);
        const entry = (called[family] ??= { calls: 0, loaded: 0, signals: {} });
        entry.calls += 1;
        if (selection.names.includes(family)) {
          entry.loaded += 1;
          for (const reason of selection.why[family])
            entry.signals[reason] = (entry.signals[reason] ?? 0) + 1;
        } else missedLengths.push(text.length);
        previousFamily = family;
      }
      if (!operations.length && selection.names.length === 1) previousFamily = selection.names[0];
    }
    return {
      turns: turns.length,
      plannerTurns,
      loadedTurns,
      plannerLoadedTurns,
      toolsLoaded,
      meanWireCharsWhenLoaded: loadedTurns ? Math.round(loadedChars / loadedTurns) : 0,
      meanWireCharsPerTurn: Math.round(loadedChars / turns.length),
      meanWireCharsPerPlannerTurn: Math.round(plannerLoadedChars / Math.max(1, plannerTurns)),
      loadedForReasonOtherThanViewTurns: loadedWithoutViewTurns,
      selectedCounts,
      strongestSignal: bySignal,
      deviceCalls: called,
      missedMessageLengths: missedLengths,
    };
  })();

  const report = {
    capabilities: CAPABILITIES.length,
    wireOverheadPerTool: WIRE_OVERHEAD_PER_TOOL,
    umbrella: {
      ...row(umbrella),
      ordinaryHome: row(ordinaryUmbrella("home")),
      ordinaryMaps: row(ordinaryUmbrella("maps")),
      ordinaryCalendar: row(ordinaryUmbrella("calendar")),
    },
    families: projected.flatMap((family) => {
      const tool = fullFamilies.get(family.name);
      return tool ? [row(tool)] : [];
    }),
    familiesOrdinaryHome: projected.flatMap((family) => {
      const tool = familyTool(family, CAPABILITIES, (type) => ordinaryTurnAdmits(type, "home"));
      return tool ? [row(tool)] : [];
    }),
    familiesOrdinaryMaps: projected.flatMap((family) => {
      const tool = familyTool(family, CAPABILITIES, (type) => ordinaryTurnAdmits(type, "maps"));
      return tool ? [row(tool)] : [];
    }),
    split,
    singles: singleRows,
    coverage,
    sampleDescription: (fullFamilies.get("DEVICE_CLOCK") as Action).description,
    requests: requestRows,
    summary,
    heldOut: heldOutRows,
    heldOutSummary,
    traffic,
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 1));
});
