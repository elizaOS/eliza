import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const NATIVE_APPLE_REMINDER_METADATA_KEY = "nativeAppleReminder";

export type NativeAppleReminderLikeKind = "alarm" | "reminder";

type NativeAppleReminderMetadata = {
  kind: NativeAppleReminderLikeKind;
  provider: "apple_reminders";
  reminderId?: string | null;
  source: "heuristic" | "llm";
};

export function buildNativeAppleReminderMetadata(args: {
  kind: NativeAppleReminderLikeKind;
  reminderId?: string | null;
  source: "heuristic" | "llm";
}): Record<string, unknown> {
  return {
    [NATIVE_APPLE_REMINDER_METADATA_KEY]: {
      kind: args.kind,
      provider: "apple_reminders",
      reminderId:
        typeof args.reminderId === "string" && args.reminderId.trim().length > 0
          ? args.reminderId.trim()
          : null,
      source: args.source,
    } satisfies NativeAppleReminderMetadata,
  };
}

export function readNativeAppleReminderMetadata(
  metadata: unknown,
): NativeAppleReminderMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[
    NATIVE_APPLE_REMINDER_METADATA_KEY
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind =
    record.kind === "alarm" || record.kind === "reminder" ? record.kind : null;
  const source =
    record.source === "llm" || record.source === "heuristic"
      ? record.source
      : null;
  if (kind === null || source === null) {
    return null;
  }
  const reminderId =
    typeof record.reminderId === "string" && record.reminderId.trim().length > 0
      ? record.reminderId.trim()
      : null;
  return {
    kind,
    provider: "apple_reminders",
    reminderId,
    source,
  };
}

type ReminderDateParts = {
  day: number;
  month: number;
  secondsSinceMidnight: number;
  year: number;
};

function reminderDateParts(dueAt: string): ReminderDateParts | null {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    secondsSinceMidnight:
      date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds(),
  };
}

function buildReminderNotes(args: {
  kind: NativeAppleReminderLikeKind;
  notes?: string | null;
  originalIntent?: string | null;
}): string {
  const parts = [
    args.notes?.trim() ?? "",
    args.originalIntent?.trim()
      ? `Eliza request: ${args.originalIntent.trim()}`
      : "",
  ].filter((value) => value.length > 0);
  if (parts.length > 0) {
    return parts.join("\n\n");
  }
  return args.kind === "alarm"
    ? "Created by Eliza as an alarm-like reminder."
    : "Created by Eliza.";
}

function appleReminderPriority(kind: NativeAppleReminderLikeKind): number {
  return kind === "alarm" ? 1 : 5;
}

const APPLE_REMINDER_SCRIPT = [
  "on run argv",
  "set reminderTitle to item 1 of argv",
  "set reminderNotes to item 2 of argv",
  "set dueYear to (item 3 of argv) as integer",
  "set dueMonth to (item 4 of argv) as integer",
  "set dueDay to (item 5 of argv) as integer",
  "set dueSeconds to (item 6 of argv) as integer",
  "set reminderPriority to (item 7 of argv) as integer",
  'tell application "Reminders"',
  "set targetList to default list",
  "set newReminder to missing value",
  "tell targetList",
  "set newReminder to make new reminder with properties {name:reminderTitle}",
  "end tell",
  'if reminderNotes is not "" then set body of newReminder to reminderNotes',
  "if dueYear > 0 then",
  "set dueDate to current date",
  "set year of dueDate to dueYear",
  "set month of dueDate to dueMonth",
  "set day of dueDate to dueDay",
  "set time of dueDate to dueSeconds",
  "set due date of newReminder to dueDate",
  "set remind me date of newReminder to dueDate",
  "end if",
  "if reminderPriority > 0 then set priority of newReminder to reminderPriority",
  "return id of newReminder",
  "end tell",
  "end run",
];

const APPLE_REMINDER_UPDATE_SCRIPT = [
  "on run argv",
  "set reminderId to item 1 of argv",
  "set reminderTitle to item 2 of argv",
  "set reminderNotes to item 3 of argv",
  "set dueYear to (item 4 of argv) as integer",
  "set dueMonth to (item 5 of argv) as integer",
  "set dueDay to (item 6 of argv) as integer",
  "set dueSeconds to (item 7 of argv) as integer",
  "set reminderPriority to (item 8 of argv) as integer",
  'tell application "Reminders"',
  "repeat with targetList in lists",
  "repeat with candidate in reminders of targetList",
  "if id of candidate is reminderId then",
  "set name of candidate to reminderTitle",
  'if reminderNotes is not "" then',
  "set body of candidate to reminderNotes",
  "else",
  'set body of candidate to ""',
  "end if",
  "if dueYear > 0 then",
  "set dueDate to current date",
  "set year of dueDate to dueYear",
  "set month of dueDate to dueMonth",
  "set day of dueDate to dueDay",
  "set time of dueDate to dueSeconds",
  "set due date of candidate to dueDate",
  "set remind me date of candidate to dueDate",
  "end if",
  "if reminderPriority > 0 then set priority of candidate to reminderPriority",
  "return id of candidate",
  "end if",
  "end repeat",
  "end repeat",
  "end tell",
  'error "Reminder not found"',
  "end run",
];

const APPLE_REMINDER_DELETE_SCRIPT = [
  "on run argv",
  "set reminderId to item 1 of argv",
  'tell application "Reminders"',
  "repeat with targetList in lists",
  "tell targetList",
  "set matchingReminders to (every reminder whose id is reminderId)",
  "if (count of matchingReminders) > 0 then",
  "delete item 1 of matchingReminders",
  'return "deleted"',
  "end if",
  "end tell",
  "end repeat",
  "end tell",
  'error "Reminder not found"',
  "end run",
];

async function execAppleReminderScript(
  scriptLines: string[],
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    scriptLines.flatMap((line) => ["-e", line]).concat(args),
    { timeout: 30_000 },
  );
  return typeof stdout === "string" ? stdout.trim() : "";
}

export async function createNativeAppleReminderLikeItem(args: {
  kind: NativeAppleReminderLikeKind;
  title: string;
  dueAt: string;
  notes?: string | null;
  originalIntent?: string | null;
}): Promise<
  | {
      ok: true;
      provider: "apple_reminders";
      reminderId: string | null;
    }
  | {
      ok: false;
      provider: "apple_reminders";
      error: string;
      skippedReason:
        | "unsupported_platform"
        | "invalid_due_at"
        | "missing_title"
        | "native_error";
    }
> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      provider: "apple_reminders",
      error: "Native Apple reminders are only available on macOS.",
      skippedReason: "unsupported_platform",
    };
  }

  const title = args.title.trim();
  if (!title) {
    return {
      ok: false,
      provider: "apple_reminders",
      error: "Reminder title is required.",
      skippedReason: "missing_title",
    };
  }

  const parts = reminderDateParts(args.dueAt);
  if (!parts) {
    return {
      ok: false,
      provider: "apple_reminders",
      error: `Invalid dueAt for native Apple reminder: ${args.dueAt}`,
      skippedReason: "invalid_due_at",
    };
  }

  try {
    const reminderId = await execAppleReminderScript(APPLE_REMINDER_SCRIPT, [
      title,
      buildReminderNotes(args),
      String(parts.year),
      String(parts.month),
      String(parts.day),
      String(parts.secondsSinceMidnight),
      String(appleReminderPriority(args.kind)),
    ]);
    return {
      ok: true,
      provider: "apple_reminders",
      reminderId: reminderId || null,
    };
  } catch (error) {
    const details =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      provider: "apple_reminders",
      error: details || "Failed to create native Apple reminder.",
      skippedReason: "native_error",
    };
  }
}

export async function updateNativeAppleReminderLikeItem(args: {
  reminderId: string;
  kind: NativeAppleReminderLikeKind;
  title: string;
  dueAt: string;
  notes?: string | null;
  originalIntent?: string | null;
}): Promise<
  | {
      ok: true;
      provider: "apple_reminders";
      reminderId: string | null;
    }
  | {
      ok: false;
      provider: "apple_reminders";
      error: string;
      skippedReason:
        | "unsupported_platform"
        | "invalid_due_at"
        | "missing_title"
        | "missing_reminder_id"
        | "native_error";
    }
> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      provider: "apple_reminders",
      error: "Native Apple reminders are only available on macOS.",
      skippedReason: "unsupported_platform",
    };
  }

  const reminderId = args.reminderId.trim();
  if (!reminderId) {
    return {
      ok: false,
      provider: "apple_reminders",
      error: "Native Apple reminder id is required.",
      skippedReason: "missing_reminder_id",
    };
  }

  const title = args.title.trim();
  if (!title) {
    return {
      ok: false,
      provider: "apple_reminders",
      error: "Reminder title is required.",
      skippedReason: "missing_title",
    };
  }

  const parts = reminderDateParts(args.dueAt);
  if (!parts) {
    return {
      ok: false,
      provider: "apple_reminders",
      error: `Invalid dueAt for native Apple reminder: ${args.dueAt}`,
      skippedReason: "invalid_due_at",
    };
  }

  try {
    const nextReminderId = await execAppleReminderScript(
      APPLE_REMINDER_UPDATE_SCRIPT,
      [
        reminderId,
        title,
        buildReminderNotes(args),
        String(parts.year),
        String(parts.month),
        String(parts.day),
        String(parts.secondsSinceMidnight),
        String(appleReminderPriority(args.kind)),
      ],
    );
    return {
      ok: true,
      provider: "apple_reminders",
      reminderId: nextReminderId || reminderId,
    };
  } catch (error) {
    const details =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      provider: "apple_reminders",
      error: details || "Failed to update native Apple reminder.",
      skippedReason: "native_error",
    };
  }
}

export async function deleteNativeAppleReminderLikeItem(
  reminderId: string,
): Promise<
  | {
      ok: true;
      provider: "apple_reminders";
    }
  | {
      ok: false;
      provider: "apple_reminders";
      error: string;
      skippedReason:
        | "unsupported_platform"
        | "missing_reminder_id"
        | "native_error";
    }
> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      provider: "apple_reminders",
      error: "Native Apple reminders are only available on macOS.",
      skippedReason: "unsupported_platform",
    };
  }

  const normalizedReminderId = reminderId.trim();
  if (!normalizedReminderId) {
    return {
      ok: false,
      provider: "apple_reminders",
      error: "Native Apple reminder id is required.",
      skippedReason: "missing_reminder_id",
    };
  }

  try {
    await execAppleReminderScript(APPLE_REMINDER_DELETE_SCRIPT, [
      normalizedReminderId,
    ]);
    return {
      ok: true,
      provider: "apple_reminders",
    };
  } catch (error) {
    const details =
      typeof error === "object" && error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      provider: "apple_reminders",
      error: details || "Failed to delete native Apple reminder.",
      skippedReason: "native_error",
    };
  }
}
