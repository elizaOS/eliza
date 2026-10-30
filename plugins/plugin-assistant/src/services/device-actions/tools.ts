/** Narrow owner-device operations over the canonical proposal/approval/receipt path. */
import type {
  Action,
  ActionParameterSchema,
  HandlerOptions,
} from "@elizaos/core";
import {
  ElizaError,
  parseWebResourceAddress,
  registerDirectActionRoutingRule,
} from "@elizaos/core";
import { proposeDeviceAction } from "./action.ts";
import {
  CALENDAR_CAPABILITY,
  CALENDAR_CREATE_CAPABILITY,
  CALENDAR_NEXT_CAPABILITY,
} from "./calendar-contract.ts";
import { deviceOperationSupportedByCapabilities } from "./contract.ts";
import { MAPS_CAPABILITY } from "./maps-contract.ts";
import { NOTES_CAPABILITY, notesSelectionTarget } from "./notes-contract.ts";
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
  "notes_update",
  "calendar_create_local",
  "calendar_create",
  "calendar_read_next",
  "calendar_read_selected",
  "calendar_update",
  "maps_read_selected",
  "reminder_create_after",
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
    "Open an explicitly requested HTTPS address in this requesting app Browser. Use this app-owned operation instead of the server Browser workspace when the user asks to open a site in this app. Navigation only; do not claim page content or successful loading.",
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
    "Share only the current explicitly selected map place or route after device review. This does not request location or search for places.",
  ],
] as const;
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
  if (selected.length !== 1)
    throw Error("Canonical device operation is not uniquely declared: " + type);
  return readableReminderOperationSchema(type, { anyOf: selected });
}
export const deviceActionTools: readonly Action[] = Object.freeze(
  declarations.map(([name, type, description]) => ({
    ...proposeDeviceAction,
    name,
    description,
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
      type === "browser_navigate"
        ? [
            "domain:browser",
            "capability:navigate",
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
      type === "browser_navigate"
        ? ["DEVICE_BROWSER_NAVIGATE"]
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
    contexts:
      type === "maps_read_selected"
        ? ["phone", "maps", "general"]
        : type.startsWith("calendar_read") || type === "calendar_update"
          ? ["calendar", "general"]
          : type === "reminder_create_after"
            ? ["tasks", "reminders", "general"]
            : reminderTypes.has(type)
              ? ["tasks", "reminders", "general"]
              : type === "browser_navigate"
                ? ["browser", "web", "general"]
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
                ? { ...parameter, schema: operationSchema(type) }
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
      return proposeDeviceAction.handler(...args);
    },
  })),
);

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
    const command =
      /^(?:please\s+)?(?:open|visit|navigate\s+to|go\s+to)\s+([^\s]+)[.!]?$/iu.exec(
        text.trim(),
      );
    if (!command) return false;
    const address = parseWebResourceAddress(command[1].replace(/[.!]$/u, ""));
    return address?.protocol === "https:";
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
