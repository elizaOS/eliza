import {
  requestedSmsDraftRecipient,
  SMS_COMPOSE_TARGET_CAPABILITY,
  SMS_SENDER_ADDRESS_CAPABILITY,
} from "@elizaos/contracts/telephony-actions";
/** Narrow owner-device operations over the canonical proposal/approval/receipt path. */
import type {
  Action,
  ActionParameterSchema,
  HandlerOptions,
} from "@elizaos/core";
import { ElizaError, registerDirectActionRoutingRule } from "@elizaos/core";
import { proposeDeviceAction } from "./action.ts";
import { isBrowserControlType } from "./browser-contract.ts";
import { authoredBrowserDestination } from "./browser-request-grounding.ts";
import {
  CALENDAR_CAPABILITY,
  CALENDAR_CREATE_CAPABILITY,
  CALENDAR_NEXT_CAPABILITY,
} from "./calendar-contract.ts";
import {
  CAMERA_CAPTURE_CAPABILITY,
  DEVICE_CAMERA_CAPTURE_ACTION,
} from "./camera-contract.ts";
import { authoredCameraCapture } from "./camera-request.ts";
import { deviceOperationSupportedByCapabilities } from "./contract.ts";
import { MAPS_CAPABILITY } from "./maps-contract.ts";
import { NOTES_CAPABILITY, notesSelectionTarget } from "./notes-contract.ts";
import { isNotesOrganizeType } from "./notes-organize-contract.ts";
import { isPhotosViewType } from "./photos-view-contract.ts";
import { deviceReadHostContextRevision } from "./read-completion.ts";
import {
  REMINDER_CAPABILITY,
  REMINDER_TIMING_CAPABILITY,
} from "./reminder-contract.ts";
import { REMINDER_CREATE_CAPABILITY } from "./reminder-create-contract.ts";
import {
  readableReminderOperationSchema,
  resolveReadableReminderOperation,
} from "./reminder-local-time.ts";
import {
  currentReminderRecordSource,
  deviceAppRecordOperationAvailable,
  getDeviceActionTurn,
  requestLocalCalendarUpdate,
  requestLocalNotesUpdate,
} from "./service.ts";
import {
  authoredKeypadRequest,
  authoredTelephonyRequest,
  emergencyServicesRequest,
} from "./telephony-request.ts";
import { turnObservation } from "./turn-observation.ts";

function capabilityAvailable(
  type: string,
  runtime: Parameters<NonNullable<Action["validate"]>>[0],
): boolean {
  const turn = getDeviceActionTurn();
  if (!turn || turn.runtime !== runtime) return false;
  const caps = turn.credential.capabilities;
  if (type === "notes_update")
    return (
      turn.isCurrent() &&
      caps?.includes(NOTES_CAPABILITY) === true &&
      deviceReadHostContextRevision(runtime) !== null
    );
  if (type === "calendar_update")
    return (
      turn.isCurrent() &&
      caps?.includes(CALENDAR_CAPABILITY) === true &&
      deviceReadHostContextRevision(runtime) !== null
    );
  if (isNotesOrganizeType(type))
    return deviceOperationSupportedByCapabilities(type, caps);
  if (type === "camera_capture_photo")
    return (
      turn.isCurrent() && caps?.includes(CAMERA_CAPTURE_CAPABILITY) === true
    );
  if (isPhotosViewType(type) || isBrowserControlType(type))
    return (
      turn.isCurrent() && deviceOperationSupportedByCapabilities(type, caps)
    );
  if (
    type === "reminder_create_after" &&
    runtime.actions.some((action) => action.name === "OWNER_REMINDERS") &&
    currentReminderRecordSource(runtime) !== "device"
  )
    return false;
  return type === "calendar_create_local"
    ? caps?.includes(CALENDAR_CREATE_CAPABILITY) === true
    : type === "calendar_create"
      ? caps?.includes(CALENDAR_CAPABILITY) === true
      : type === "calendar_read_next"
        ? caps?.includes(CALENDAR_NEXT_CAPABILITY) === true
        : type === "calendar_read_selected"
          ? caps?.includes(CALENDAR_CAPABILITY) === true
          : type === "maps_read_selected"
            ? caps?.includes(MAPS_CAPABILITY) === true
            : type === "reminder_create_after"
              ? caps?.includes(REMINDER_CREATE_CAPABILITY) === true
              : false;
}
const capabilityBoundTypes = new Set([
  "camera_capture_photo",
  "notes_update",
  "calendar_create_local",
  "calendar_create",
  "calendar_read_next",
  "calendar_read_selected",
  "calendar_update",
  "maps_read_selected",
  "reminder_create_after",
  "notes_filter",
  "notes_list_filter",
  "notes_move",
  "notes_folder_create",
  "notes_restore",
  "notes_record",
  "photos_filter",
  "photos_open",
  "photos_album_create",
  "photos_share",
  "browser_search",
  "browser_tab_new",
  "browser_tab_switch",
  "browser_tab_close",
  "browser_find",
]);
const reminderTypes = new Set([
  "reminder_create",
  "reminder_read_selected",
  "reminder_update",
  "reminder_complete",
  "reminder_snooze",
  "reminder_cancel",
]);
function reminderAvailable(
  type: string,
  runtime: Parameters<NonNullable<Action["validate"]>>[0],
): boolean {
  const turn = getDeviceActionTurn();
  if (!turn || turn.runtime !== runtime) return false;
  if (
    runtime.actions.some((action) => action.name === "OWNER_REMINDERS") &&
    currentReminderRecordSource(runtime) !== "device"
  )
    return false;
  return type === "reminder_create"
    ? turn.credential.capabilities?.includes(REMINDER_CREATE_CAPABILITY) ===
        true
    : turn.credential.capabilities?.some(
        (value) =>
          value === REMINDER_CAPABILITY || value === REMINDER_TIMING_CAPABILITY,
      ) === true;
}
const declarations = [
  [
    "DEVICE_BROWSER_OPEN",
    "browser_navigate",
    'Open a web address the user supplied in this message in the requesting app Browser, only when they ask to open, visit or go to it now, including "in the browser" or "in a new tab". Use the supplied address, writing any spoken hostname dots as periods, for example "example dot com" as "example.com". Set newTab true when they ask for a new tab (browser.open-new-tab.v1). Opening the Browser view does not load an address: use this operation for the address. Use this app-owned operation instead of the server Browser workspace when the user asks to open a site in this app. Navigation only; do not claim page content or successful loading.',
  ],
  // The phone Browser's own controls. They were offered only on
  // PROPOSE_DEVICE_ACTION, which is not a browser-context tool, so a turn
  // routed as browser found only the native BROWSER back/forward/reload
  // commands, and "switch to the example.com tab" was answered with "I can
  // only go back, forward, or reload" (v612). These tools are browser-context
  // only: PROPOSE_DEVICE_ACTION still offers the same operations in general,
  // where five more Browser tools would outrank web search, Notes and the rest.
  // browser_history has no tool of its own: in the browser context the native
  // BROWSER back, forward and reload commands answer it directly, and
  // answered "no previous page" honestly on v612.
  [
    "DEVICE_BROWSER_TAB_SWITCH",
    "browser_tab_switch",
    "Show an open tab in this phone's Browser (browser.tabs.v1) when the owner asks to switch to, go to or show a tab. target is a word of the tab's title or site exactly as the owner said it, such as example.com or bbc. The phone finds the tab, the owner picks when several match, and the phone reports when no open tab matches. You never receive the list of tabs, a title or an address; never say which tabs are open.",
  ],
  [
    "DEVICE_BROWSER_TAB_CLOSE",
    "browser_tab_close",
    "Close a tab in this phone's Browser (browser.tabs.v1). target is a word of the tab's title or site as the owner said it; leave it out to close the tab that is showing. Closing a tab is always reviewed by the owner. You never receive the list of tabs.",
  ],
  [
    "DEVICE_BROWSER_TAB_NEW",
    "browser_tab_new",
    "Open an empty tab in this phone's Browser (browser.tabs.v1); private true only when the owner asks for a private tab. It never loads an address: to open a typed address in a new tab use DEVICE_BROWSER_OPEN with newTab true instead.",
  ],
  [
    "DEVICE_BROWSER_SEARCH",
    "browser_search",
    "Open a web search in this phone's Browser (browser.search.v1) when the owner asks to search the web, look something up online or google something now. query is the words the user typed in this message, copied exactly.",
  ],
  [
    "DEVICE_BROWSER_PAGE_SEARCH",
    "browser_find",
    "Find (search for) text on the page open in this phone's Browser (browser.find.v1) and show the matches. You receive no match count and no page content.",
  ],
  [
    DEVICE_CAMERA_CAPTURE_ACTION,
    "camera_capture_photo",
    "Take a photo with this phone's camera and save it in Photos, when the owner asks to take a picture, photo or selfie now. Opening the Camera view does not take a photo; this does. The phone opens Camera itself first when another view is showing. With a lens field: front for a selfie or a photo of the owner, back for the rear camera; leave it out otherwise. Sends no pixels to the model; only the saved-photo receipt proves the capture. Never repeat an uncertain capture.",
  ],
  [
    "DEVICE_NOTE_UPDATE",
    "notes_update",
    "Edit or append to the exact selected existing note from the ORIGINAL user request. Supply only operation.type=notes_update, never guessed IDs or replacement fields. The owner first shares a fresh exact snapshot, then separately reviews the requested changes. Preserve unchanged content; a read alone does not finish an edit.",
  ],
  [
    "DEVICE_NOTE_CREATE",
    "create_note",
    "Create one note in this connected device Notes store.",
  ],
  [
    "DEVICE_NOTES_QUERY",
    "notes_query",
    "Find saved connected device notes by exact title or explicit latest basis. For a request to read a note identified by title when its exact selected noteId/revision is missing, FIRST run DEVICE_NOTES_QUERY with query.kind=title and the exact requested title text. Use the returned source and record identity/revision for DEVICE_NOTE_READ. Discovery metadata is not the note body; do not invent IDs or ask the user to manually search when this authorized lookup is available.",
  ],
  [
    "DEVICE_NOTE_READ",
    "notes_read_selected",
    "Read one selected connected device note using the exact source and record identity/revision returned by the current phone selection or DEVICE_NOTES_QUERY. If the user names a title and those opaque fields are missing, first discover and run DEVICE_NOTES_QUERY; do not derive noteId from title text, guess a revision, or substitute unknown. Never treat a title string as a selected record ID.",
  ],
  [
    "DEVICE_NOTES_FILTER",
    "notes_filter",
    "Filter the Notes list on this phone by text, folder name and/or kind (text, list, voice, link). Read-only: the phone shows the matching notes with a clearable filter and returns no note content to the agent.",
  ],
  [
    "DEVICE_CANONICAL_NOTES_FILTER",
    "notes_list_filter",
    "Filter the open Notes list by text or kind (text, list, voice, link). The phone shows the filtered list with a clearable filter and returns no note content. Requires the canonical Notes list to be open.",
  ],
  [
    "DEVICE_NOTE_MOVE",
    "notes_move",
    "Move one note to a folder by folder name, or to no folder with folder null. Use the exact selected note source and record identity/revision; never guess them. The owner reviews the move; it is refused if the note changed since review or the folder does not exist.",
  ],
  [
    "DEVICE_NOTES_FOLDER_CREATE",
    "notes_folder_create",
    "Create a Notes folder with the given name (at most 40 characters). The owner reviews it first. An existing folder with the same name is kept.",
  ],
  [
    "DEVICE_NOTE_RESTORE",
    "notes_restore",
    "Restore a note from Notes Recently deleted by its noteId. Never guess the noteId. The owner reviews it first; notes deleted more than 30 days ago cannot be restored.",
  ],
  [
    "DEVICE_NOTES_RECORD",
    "notes_record",
    "Start or stop a voice note recording in the Notes app on this phone. Only works while Notes is open. Runs directly when the owner's current message asked for it, otherwise the owner reviews it. A proposal does not prove recording started or stopped.",
  ],
  [
    "DEVICE_PHOTOS_FILTER",
    "photos_filter",
    "Filter the Photos grid on this phone by date range (epoch ms), kind (image or video), favorite, album and/or text matched on the phone. Read-only: Photos shows the matching items behind a clearable filter chip and returns only how many it shows, never the items.",
  ],
  [
    "DEVICE_PHOTOS_OPEN",
    "photos_open",
    "Open one photo or video in the Photos viewer on this phone by a library id the phone returned. Nothing is changed or shared. Never guess the id.",
  ],
  [
    "DEVICE_PHOTOS_ALBUM_CREATE",
    "photos_album_create",
    "Create a Photos album with a name (1 to 80 characters) and the given library ids. The owner reviews the name and items in Photos first; review_opened does not prove the album was created. Never guess ids.",
  ],
  [
    "DEVICE_PHOTOS_SHARE",
    "photos_share",
    "Share up to 100 photos or videos by library id. The owner reviews them in Photos, then picks a target in Android's share sheet; nothing leaves the phone before that. review_opened does not prove anything was shared. Never retry automatically.",
  ],
  [
    "DEVICE_CALENDAR_CREATE",
    "calendar_create_local",
    "Create one event in this requesting device Calendar store. The requesting device reviews and confirms the change.",
  ],
  [
    "DEVICE_CALENDAR_CREATE_SELECTED",
    "calendar_create",
    "Create one event in the exact selected device Calendar source/revision. Never guess the source.",
  ],
  [
    "DEVICE_REMINDER_CREATE",
    "reminder_create",
    "Create one reminder in this connected device Reminders store using the exact requested title, body and schedule. Supply fields.schedule.localDate (YYYY-MM-DD), localTime (24-hour HH:mm or HH:mm:ss), timeZone (IANA), alertMinutes and recurrence. Never calculate or supply epoch milliseconds; the host resolves and validates time. Creation/scheduling status comes only from the native receipt; never claim an alert was scheduled from a proposal.",
  ],
  [
    "DEVICE_REMINDER_READ",
    "reminder_read_selected",
    "Read the exact currently selected connected device reminder occurrence. Copy sourceId/sourceRevision/reminderId/occurrenceId/revision and timingVersion from current typed phone context. Do not guess IDs, use backend reminders as a substitute, or claim the selected record is the full reminder list.",
  ],
  [
    "DEVICE_REMINDER_UPDATE",
    "reminder_update",
    "Update the exact selected connected device reminder occurrence using current typed source/record revisions and requested fields only. For a title-only target with no selected identity, use an available canonical reminder_named update helper for owner selection; never derive IDs from the title. Preserve timingVersion. When changing schedule, supply localDate/localTime/timeZone plus alertMinutes and recurrence; never calculate epoch milliseconds. Copy unchanged fields from the selected snapshot.",
  ],
  [
    "DEVICE_REMINDER_COMPLETE",
    "reminder_complete",
    "Mark the exact selected connected device reminder occurrence complete. Require current typed source/record identity and revisions; do not guess IDs or substitute backend reminder records. A completed receipt, not a proposal, proves the change.",
  ],
  [
    "DEVICE_REMINDER_SNOOZE",
    "reminder_snooze",
    "Snooze only the exact selected connected device reminder occurrence using its current typed identity/revisions and timingVersion. This operation uses the native fixed snooze policy and accepts no custom time. If the user requests an exact new due time, use DEVICE_REMINDER_UPDATE with readable localDate/localTime/timeZone and preserved alert/recurrence settings; do not claim fixed snooze honored a custom time.",
  ],
  [
    "DEVICE_REMINDER_CANCEL",
    "reminder_cancel",
    "Cancel the exact selected connected device reminder occurrence using current typed identity/revisions. For a title-only target with no selected identity, use an available canonical reminder_named cancel helper for owner selection; never derive IDs. A native receipt proves cancellation.",
  ],
  [
    "DEVICE_CALENDAR_READ_NEXT",
    "calendar_read_next",
    "Read the next event through the enrolled device Calendar review. This is not a connected Google Calendar read.",
  ],
  [
    "DEVICE_CALENDAR_READ_SELECTED",
    "calendar_read_selected",
    "Read only the selected device Calendar event at its exact source and record revision, after current review.",
  ],
  [
    "DEVICE_CALENDAR_UPDATE",
    "calendar_update",
    "Update the selected device Calendar event title, description (the event’s notes/body), location, time, duration or time zone from the ORIGINAL user request. Event notes belong to this Calendar event, not a separate Notes document. Supply only operation.type=calendar_update, no target or replacement fields. The owner first shares the current event snapshot, then reviews a separate update. Unchanged fields come from that approved snapshot; no change is complete until its native receipt.",
  ],
  [
    "DEVICE_REMINDER_CREATE_AFTER",
    "reminder_create_after",
    "Create one requested local reminder after the exact relative duration, through current device review. Never invent a schedule or report delivery before a receipt.",
  ],
  [
    "DEVICE_MAPS_READ_SELECTED",
    "maps_read_selected",
    "Share only the current explicitly selected map place or route after device review. This does not request location, search for places or plan routes: place search, nearby places and directions are the MAPS_PLACE, MAPS_ROUTE and MAPS_NAVIGATION_START operations.",
  ],
] as const satisfies readonly (readonly [
  name: string,
  type: string,
  description: string,
])[];
function operationSchema(type: string): ActionParameterSchema {
  if (type === "calendar_update" || type === "notes_update")
    return {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: { type: { type: "string", enum: [type] } },
        },
      ],
    };
  const parameter = proposeDeviceAction.parameters?.find(
    (value) => value.name === "operation",
  );
  const branches =
    parameter?.schema && "anyOf" in parameter.schema
      ? parameter.schema.anyOf
      : undefined;
  if (!Array.isArray(branches))
    throw Error("Canonical device operation schema unavailable");
  const selected = branches.filter(
    (branch) =>
      branch &&
      typeof branch === "object" &&
      "properties" in branch &&
      (branch.properties as Record<string, { enum?: readonly string[] }>).type
        ?.enum?.length === 1 &&
      (branch.properties as Record<string, { enum?: readonly string[] }>).type
        ?.enum?.[0] === type,
  );
  // These operations declare two forms; their tool filters one out per phone.
  const forms =
    type === "camera_capture_photo" ||
    type === "photos_album_create" ||
    type === "photos_share"
      ? 2
      : 1;
  if (selected.length !== forms)
    throw Error("Canonical device operation is not uniquely declared: " + type);
  return readableReminderOperationSchema(type, { anyOf: selected });
}
export const deviceActionTools: readonly Action[] = Object.freeze(
  declarations.map(([name, type, description]) => ({
    ...proposeDeviceAction,
    name,
    description,
    // The parent's catalog summary describes the whole device surface; a
    // single-operation tool indexes by its own description instead.
    descriptionCompressed: undefined,
    ...(type === "camera_capture_photo"
      ? {
          descriptionCompressed:
            "take a photo/picture/selfie now on this phone camera; saves to Photos; lens front|back",
          routingHint:
            "the user asks to take, snap or capture a picture, photo or selfie now -> DEVICE_CAMERA_CAPTURE (not VIEWS: opening Camera takes no photo); NOT for a deferred, hypothetical, question-about or reported mention, nor for opening Camera only",
        }
      : {}),
    ...(type === "browser_navigate"
      ? {
          routingHint:
            'the user asks to open, visit or go to a web address they supplied, now, also "in the browser" or "in a new tab" -> DEVICE_BROWSER_OPEN with that address (example dot com is example.com, newTab true for a new tab), not VIEWS_SHOW browser or browser_tab_new; NOT for a deferred ("at 5pm", "in five minutes", "tomorrow"), hypothetical, question-about ("is there a way to open...", "do I need to go to..."), past ("I used to visit") or reported ("my mom wants me to") mention, nor for a site name with no address, or one the user says not to open',
        }
      : {}),
    ...(type === "browser_find"
      ? {
          // "find" is also how owners ask for places, notes and contacts.
          routingHint:
            "the user asks to find or highlight words on the page open in the phone Browser -> DEVICE_BROWSER_PAGE_SEARCH with those words; NOT for finding a place, route, note, contact, file, photo or anything else that is not text on the open page, nor for a web search",
        }
      : {}),
    selectionIdentity:
      type === "notes_update" || type === "notes_read_selected"
        ? (selection: unknown) => {
            try {
              return notesSelectionTarget(selection).noteId;
            } catch {
              return undefined;
            }
          }
        : undefined,
    tags:
      type === "camera_capture_photo"
        ? [
            "domain:camera",
            "capability:capture",
            "effect:receipt-required",
            "target:selected-device",
          ]
        : type === "browser_navigate"
          ? [
              "domain:browser",
              "capability:navigate",
              "effect:receipt-required",
              "target:selected-device",
            ]
          : isBrowserControlType(type)
            ? [
                "domain:browser",
                "capability:control",
                "effect:receipt-required",
                "target:selected-device",
              ]
            : type === "notes_update"
              ? [
                  ...(proposeDeviceAction.tags || []),
                  "domain:notes",
                  "capability:write",
                  "effect:receipt-required",
                  "target:selected-device",
                  "selection-kind:note",
                ]
              : type === "notes_read_selected"
                ? [
                    ...(proposeDeviceAction.tags || []),
                    "domain:notes",
                    "selection-kind:note",
                  ]
                : type === "calendar_update"
                  ? [
                      ...(proposeDeviceAction.tags || []),
                      "domain:calendar",
                      "capability:write",
                      "effect:receipt-required",
                      "target:selected-device",
                      "selection-kind:calendar-event",
                    ]
                  : proposeDeviceAction.tags,
    roleGate:
      type === "calendar_update" || type === "notes_update"
        ? { minRole: "OWNER" as const }
        : proposeDeviceAction.roleGate,
    similes:
      type === "camera_capture_photo"
        ? [
            "CAMERA_CAPTURE_PHOTO",
            "TAKE_PHOTO",
            "take a picture",
            "take a selfie",
          ]
        : type === "browser_navigate"
          ? ["DEVICE_BROWSER_NAVIGATE"]
          : type === "browser_tab_switch"
            ? ["switch tab", "go to tab", "show tab"]
            : type === "browser_tab_close"
              ? ["close tab"]
              : type === "reminder_read_selected"
                ? ["DEVICE_REMINDER_READ_SELECTED"]
                : type === "notes_query"
                  ? [
                      "find note by title",
                      "look up saved note",
                      "search notes before reading",
                      "read a named note",
                    ]
                  : type === "notes_read_selected"
                    ? [
                        "read selected note",
                        "read note by returned identity and revision",
                      ]
                    : [],
    // "phone" is the telephony context: its call/text/dial keyword signals
    // ranked this Maps read above the dialer for "open the phone keypad".
    contexts:
      type === "maps_read_selected"
        ? ["maps", "general"]
        : type.startsWith("calendar_read") || type === "calendar_update"
          ? ["calendar", "general"]
          : type === "reminder_create_after"
            ? ["tasks", "reminders", "general"]
            : reminderTypes.has(type)
              ? ["tasks", "reminders", "general"]
              : type === "browser_navigate"
                ? ["browser", "web", "general"]
                : isBrowserControlType(type)
                  ? ["browser"]
                  : type === "camera_capture_photo"
                    ? ["media", "general"]
                    : isPhotosViewType(type)
                      ? ["media", "general"]
                      : type.startsWith("calendar_create")
                        ? ["calendar", "general"]
                        : ["notes", "general"],
    validate: async (
      runtime: Parameters<NonNullable<Action["validate"]>>[0],
      message: Parameters<NonNullable<Action["validate"]>>[1],
    ) => {
      if (!deviceAppRecordOperationAvailable(runtime, { type }, message))
        return false;
      const validate: Action["validate"] =
        type === "notes_update"
          ? async (
              runtime: Parameters<NonNullable<Action["validate"]>>[0],
              message: Parameters<NonNullable<Action["validate"]>>[1],
            ) => {
              if (!capabilityAvailable(type, runtime)) return false;
              try {
                const context = turnObservation(message?.content?.metadata);
                return (
                  context?.view === "notes" &&
                  !context.sensitive &&
                  !!notesSelectionTarget(context.selectedObject)
                );
              } catch {
                return false;
              }
            }
          : capabilityBoundTypes.has(type)
            ? async (runtime) => capabilityAvailable(type, runtime)
            : reminderTypes.has(type)
              ? async (runtime) => reminderAvailable(type, runtime)
              : proposeDeviceAction.validate;
      return (await validate?.(runtime, message)) ?? false;
    },
    parameters:
      type === "calendar_update" || type === "notes_update"
        ? [
            {
              name: "operation",
              required: true,
              description:
                "Prepare the original selected-record update; no model-authored replacement fields.",
              schema: operationSchema(type),
            },
          ]
        : [
            ...(proposeDeviceAction.parameters?.map((parameter) =>
              parameter.name === "operation"
                ? {
                    ...parameter,
                    // Not "phone": a single-operation tool must not match
                    // call/text/dialer queries by the parent's wording.
                    description:
                      "Exact typed device operation to show for approval",
                    schema: operationSchema(type),
                  }
                : parameter,
            ) || []),
            ...(type === "notes_query"
              ? [
                  {
                    name: "afterRead",
                    required: false,
                    description:
                      "Only when the ORIGINAL owner request explicitly asks to DELETE the note being located, set {kind:notes_delete}. The lookup will preserve that original deletion request and prepare a separate exact-target deletion review after Share. Sharing the read never approves deletion. For a read/search-only request omit this. Prefer the existing notes_named delete review when a unique name is already available.",
                    schema: {
                      type: "object" as const,
                      additionalProperties: false,
                      required: ["kind"],
                      properties: {
                        kind: {
                          type: "string" as const,
                          enum: ["notes_delete"],
                        },
                      },
                    },
                  },
                ]
              : []),
          ],
    async handler(...args: Parameters<NonNullable<Action["handler"]>>) {
      if (!deviceAppRecordOperationAvailable(args[0], { type }, args[1]))
        return {
          success: false,
          text: "Device Notes/Calendar record authority is not selected for this turn. No device proposal was created.",
          data: {
            code: "DEVICE_OPERATION_RECORD_SOURCE",
            coachingFailure: true,
          },
        };
      if (capabilityBoundTypes.has(type) && !capabilityAvailable(type, args[0]))
        return {
          success: false,
          text: "This authenticated device does not support that operation.",
          data: { code: "DEVICE_OPERATION_SCOPE" },
        };
      if (reminderTypes.has(type) && !reminderAvailable(type, args[0]))
        return {
          success: false,
          text: "This authenticated device does not support that reminder operation.",
          data: { code: "DEVICE_OPERATION_SCOPE" },
        };
      const raw = args[3]?.parameters;
      if (
        type !== "notes_query" &&
        raw &&
        typeof raw === "object" &&
        Object.hasOwn(raw, "afterRead")
      )
        return {
          success: false,
          text: "This operation has no Notes mutation continuation.",
          data: { code: "DEVICE_OPERATION_SCOPE" },
        };
      const operation =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).operation
          : undefined;
      if (
        !operation ||
        typeof operation !== "object" ||
        Array.isArray(operation) ||
        Reflect.get(operation, "type") !== type
      )
        return {
          success: false,
          text: "This action does not authorize that device operation.",
          data: { code: "DEVICE_OPERATION_SCOPE" },
        };
      if (type === "calendar_update" || type === "notes_update") {
        if (
          Object.keys(raw as Record<string, unknown>).some(
            (key) => key !== "operation",
          ) ||
          Object.keys(operation).some((key) => key !== "type")
        )
          return {
            success: false,
            text: "This selected-record tool accepts no replacement fields or guessed target. Nothing was read or changed.",
            data: {
              code:
                type === "notes_update"
                  ? "DEVICE_NOTES_UPDATE_SCOPE"
                  : "DEVICE_CALENDAR_TIME_UPDATE_SCOPE",
            },
          };
        return (
          (await (type === "notes_update"
            ? requestLocalNotesUpdate
            : requestLocalCalendarUpdate)({
            runtime: args[0],
            message: args[1],
          })) ?? {
            success: false,
            text:
              type === "notes_update"
                ? "Open the exact selected note and request its edit. Nothing was read or changed."
                : "Open the exact selected Calendar event and request the requested event changes. Nothing was read or changed.",
            data: {
              code:
                type === "notes_update"
                  ? "DEVICE_NOTES_UPDATE_SCOPE"
                  : "DEVICE_CALENDAR_TIME_UPDATE_SCOPE",
            },
          }
        );
      }
      if (type === "reminder_create" || type === "reminder_update") {
        let resolved: Record<string, unknown>;
        try {
          resolved = resolveReadableReminderOperation(operation);
        } catch {
          return {
            success: false,
            text: "Reminder time is invalid or ambiguous. Supply the exact localDate (YYYY-MM-DD), localTime (HH:mm or HH:mm:ss), and IANA timeZone; nonexistent or repeated DST times need clarification. No reminder was proposed.",
            data: { code: "DEVICE_REMINDER_LOCAL_TIME_INVALID" },
          };
        }
        const next = [...args] as Parameters<NonNullable<Action["handler"]>>;
        next[3] = {
          ...(args[3] as HandlerOptions | undefined),
          parameters: {
            ...(raw as Record<string, unknown>),
            operation: resolved,
          } as HandlerOptions["parameters"],
        };
        if (!proposeDeviceAction.handler)
          throw new ElizaError("Device action handler is unavailable", {
            code: "DEVICE_ACTION_HANDLER_UNAVAILABLE",
          });
        return proposeDeviceAction.handler(...next);
      }
      if (!proposeDeviceAction.handler)
        throw new ElizaError("Device action handler is unavailable", {
          code: "DEVICE_ACTION_HANDLER_UNAVAILABLE",
        });
      // A camera capture's lens is the one the owner named; the service
      // applies that for every tool that proposes one (proposeWithOutcome).
      return proposeDeviceAction.handler(...args);
    },
  })),
);

/** Availability for a whole-message photo command ("take a picture"). The
 * first-stage view judgment may read it as opening Camera, which takes no
 * photo; this route replaces that view-only plan with the capture tool. The
 * tool creates a durable proposal that the requesting phone runs on its
 * Camera viewfinder; the phone's saved-photo receipt owns completion.
 */
export function registerDeviceCameraCaptureRouting(
  runtime: Parameters<typeof registerDirectActionRoutingRule>[0],
): void {
  const matches = (
    text: string,
    message?: Parameters<NonNullable<Action["validate"]>>[1],
  ): boolean => {
    const current = getDeviceActionTurn();
    const caller = current?.requestCaller;
    if (
      !message ||
      current?.runtime !== runtime ||
      !current.isCurrent() ||
      current.requestMessage?.message !== message ||
      caller?.role !== "OWNER" ||
      caller.entityId !== message.entityId ||
      caller.subjectUserId !== current.credential.subjectUserId ||
      message.content.source !== "client_chat" ||
      !["DM", "VOICE_DM"].includes(String(message.content.channelType)) ||
      !deviceOperationSupportedByCapabilities(
        "camera_capture_photo",
        current.credential.capabilities,
      )
    )
      return false;
    // Only the strict whole-message command skips the model's judgment.
    return authoredCameraCapture(text, runtime.character.name) !== undefined;
  };
  registerDirectActionRoutingRule(runtime, {
    id: "device.camera-capture",
    actionNames: [DEVICE_CAMERA_CAPTURE_ACTION],
    replacesActionNames: [
      "VIEWS",
      "VIEWS_SHOW",
      "VISION_CAPTURE",
      "VISION_ENABLE_CAMERA",
    ],
    requiredActionTags: [
      "domain:camera",
      "capability:capture",
      "effect:receipt-required",
      "target:selected-device",
    ],
    contexts: ["media", "general"],
    matches,
    wholeRequest: { matches, invalidateFields: ["visualContinuation"] },
  });
}

/** Availability for a complete URL-open request. The tool creates a durable
 * proposal that the requesting phone runs directly in direct-request mode
 * (reviewed otherwise); the phone's typed receipt owns completion.
 */
export function registerDeviceBrowserOpenRouting(
  runtime: Parameters<typeof registerDirectActionRoutingRule>[0],
): void {
  const matches = (
    text: string,
    message?: Parameters<NonNullable<Action["validate"]>>[1],
  ): boolean => {
    const current = getDeviceActionTurn();
    const caller = current?.requestCaller;
    if (
      !message ||
      current?.runtime !== runtime ||
      !current.isCurrent() ||
      current.requestMessage?.message !== message ||
      caller?.role !== "OWNER" ||
      caller.entityId !== message.entityId ||
      caller.subjectUserId !== current.credential.subjectUserId ||
      message.content.source !== "client_chat" ||
      !["DM", "VOICE_DM"].includes(String(message.content.channelType)) ||
      !deviceOperationSupportedByCapabilities(
        "browser_navigate",
        current.credential.capabilities,
      )
    )
      return false;
    // Only the strict whole-message command skips the model's judgment.
    // Every other phrasing goes to the planner, whose browser proposal the
    // service grounds in the address the user typed.
    return (
      authoredBrowserDestination(text, runtime.character.name) !== undefined
    );
  };
  registerDirectActionRoutingRule(runtime, {
    id: "device.browser-open",
    actionNames: ["DEVICE_BROWSER_OPEN"],
    replacesActionNames: [
      "VIEWS",
      "VIEWS_SHOW",
      "BROWSER",
      "BROWSER_OPEN",
      "BROWSER_NAVIGATE",
    ],
    requiredActionTags: [
      "domain:browser",
      "capability:navigate",
      "effect:receipt-required",
      "target:selected-device",
    ],
    contexts: ["browser", "web", "general"],
    matches,
    wholeRequest: { matches, invalidateFields: ["visualContinuation"] },
  });
}

/**
 * The phone's negotiated capabilities when this is the owner's own current
 * phone chat request (client_chat DM or VOICE_DM) on the bound device turn.
 */
function ownerPhoneChatCapabilities(
  runtime: Parameters<typeof registerDirectActionRoutingRule>[0],
  message?: Parameters<NonNullable<Action["validate"]>>[1],
): readonly string[] | undefined {
  const current = getDeviceActionTurn();
  const caller = current?.requestCaller;
  if (
    !message ||
    current?.runtime !== runtime ||
    !current.isCurrent() ||
    current.requestMessage?.message !== message ||
    caller?.role !== "OWNER" ||
    caller.entityId !== message.entityId ||
    caller.subjectUserId !== current.credential.subjectUserId ||
    message.content.source !== "client_chat" ||
    !["DM", "VOICE_DM"].includes(String(message.content.channelType))
  )
    return;
  return current.credential.capabilities ?? [];
}

/**
 * Availability for a whole-message call or text command ("call 415-555-0100",
 * "text Sam saying ..."). Stage 1 answered such turns with a simple reply that
 * repeated an earlier "no SMS connector" refusal from history (v609 peer
 * evidence), so the planner never saw the phone's own operations. This route
 * only promotes the turn to PROPOSE_DEVICE_ACTION; the call or text is still
 * an owner-reviewed proposal on the phone.
 */
export function registerDeviceTelephonyRouting(
  runtime: Parameters<typeof registerDirectActionRoutingRule>[0],
): void {
  const matches = (
    text: string,
    message?: Parameters<NonNullable<Action["validate"]>>[1],
  ): boolean => {
    const capabilities = ownerPhoneChatCapabilities(runtime, message);
    if (!capabilities) return false;
    // An emergency request ("call an ambulance", "call for help") always
    // reaches the phone: its keypad opens for the local emergency number.
    if (emergencyServicesRequest(text))
      return (
        deviceOperationSupportedByCapabilities("phone_keypad", capabilities) ||
        deviceOperationSupportedByCapabilities("phone_call", capabilities)
      );
    const request = authoredTelephonyRequest(text);
    if (request === "sender")
      return deviceOperationSupportedByCapabilities(
        "sms_latest_sender",
        capabilities,
      );
    if (request === "call")
      return deviceOperationSupportedByCapabilities("phone_call", capabilities);
    if (
      request === "text" &&
      requestedSmsDraftRecipient(text)?.kind === "previous-sender"
    )
      return (
        capabilities.includes(SMS_SENDER_ADDRESS_CAPABILITY) &&
        capabilities.includes(SMS_COMPOSE_TARGET_CAPABILITY) &&
        deviceOperationSupportedByCapabilities("sms_compose", capabilities)
      );
    if (request === "text")
      return (
        deviceOperationSupportedByCapabilities("sms_compose", capabilities) ||
        deviceOperationSupportedByCapabilities("sms_send", capabilities)
      );
    return false;
  };
  registerDirectActionRoutingRule(runtime, {
    id: "device.telephony",
    actionNames: ["PROPOSE_DEVICE_ACTION"],
    replacesActionNames: [
      "VIEWS",
      "VIEWS_SHOW",
      "VOICE_CALL",
      "MESSAGE_SEND",
      "PAGE_DELEGATE",
    ],
    requiredActionTags: [],
    contexts: ["phone", "messaging", "general"],
    matches,
  });
}

/**
 * Availability for a whole-message keypad command ("open the dialer", "open
 * the keypad and type 415 302 4399"). "Dialer" and "keypad" also name the
 * Phone view, so Stage 1 judged these direct navigation and the phone opened
 * on Recents with no keypad (v610 device evidence). This route owns the whole
 * request: it drops that view-only plan and the staged navigation judgment and
 * leaves PROPOSE_DEVICE_ACTION, whose phone_keypad operation takes the number
 * written here. Opening the keypad never dials; "call X" stays with the
 * telephony route and "open the phone app" with view navigation.
 */
export function registerDeviceKeypadRouting(
  runtime: Parameters<typeof registerDirectActionRoutingRule>[0],
): void {
  const matches = (
    text: string,
    message?: Parameters<NonNullable<Action["validate"]>>[1],
  ): boolean => {
    const capabilities = ownerPhoneChatCapabilities(runtime, message);
    return (
      capabilities !== undefined &&
      deviceOperationSupportedByCapabilities("phone_keypad", capabilities) &&
      authoredKeypadRequest(text) !== undefined
    );
  };
  registerDirectActionRoutingRule(runtime, {
    id: "device.phone-keypad",
    actionNames: ["PROPOSE_DEVICE_ACTION"],
    replacesActionNames: ["VIEWS", "VIEWS_SHOW", "REPLY"],
    requiredActionTags: [],
    contexts: ["phone", "general"],
    matches,
    wholeRequest: { matches, invalidateFields: ["visualContinuation"] },
  });
}
