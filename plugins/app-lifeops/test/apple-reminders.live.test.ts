import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import {
  createNativeAppleReminderLikeItem,
  deleteNativeAppleReminderLikeItem,
  updateNativeAppleReminderLikeItem,
} from "../src/lifeops/apple-reminders.js";

const execFileAsync = promisify(execFile);
const LIVE_TESTS_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const LIVE_APPLE_REMINDER_TESTS_ENABLED =
  LIVE_TESTS_ENABLED &&
  process.platform === "darwin" &&
  process.env.ELIZA_LIVE_APPLE_REMINDERS_TEST === "1";

if (!LIVE_APPLE_REMINDER_TESTS_ENABLED) {
  const reasons = [
    !LIVE_TESTS_ENABLED ? "set ELIZA_LIVE_TEST=1" : null,
    process.platform !== "darwin" ? "run on macOS" : null,
    process.env.ELIZA_LIVE_APPLE_REMINDERS_TEST !== "1"
      ? "set ELIZA_LIVE_APPLE_REMINDERS_TEST=1"
      : null,
  ]
    .filter(Boolean)
    .join(" | ");
  console.info(`[apple-reminders-live] skipped: ${reasons}`);
}

const describeLive = describeIf(LIVE_APPLE_REMINDER_TESTS_ENABLED);
const FIELD_SEPARATOR = String.fromCharCode(30);
const READ_REMINDER_SCRIPT = [
  "on run argv",
  "set reminderId to item 1 of argv",
  `set fieldSeparator to "${FIELD_SEPARATOR}"`,
  'tell application "Reminders"',
  "repeat with targetList in lists",
  "repeat with candidate in reminders of targetList",
  "if id of candidate is reminderId then",
  'set reminderBody to ""',
  "try",
  "set reminderBody to body of candidate",
  "end try",
  'set dueText to ""',
  "try",
  "if due date of candidate is not missing value then",
  "set dueText to (due date of candidate) as string",
  "end if",
  "end try",
  "return (id of candidate as string) & fieldSeparator & (name of candidate as string) & fieldSeparator & reminderBody & fieldSeparator & dueText",
  "end if",
  "end repeat",
  "end repeat",
  "end tell",
  'return ""',
  "end run",
];

type NativeReminderSnapshot = {
  body: string;
  dueText: string;
  reminderId: string;
  title: string;
};

async function readReminderById(
  reminderId: string,
): Promise<NativeReminderSnapshot | null> {
  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    READ_REMINDER_SCRIPT.flatMap((line) => ["-e", line]).concat([reminderId]),
    { timeout: 30_000 },
  );
  const text = typeof stdout === "string" ? stdout.trim() : "";
  if (!text) {
    return null;
  }
  const [resolvedId, title, body, dueText] = text.split(FIELD_SEPARATOR);
  if (!resolvedId || !title) {
    return null;
  }
  return {
    reminderId: resolvedId,
    title,
    body: body ?? "",
    dueText: dueText ?? "",
  };
}

async function waitForReminder(
  reminderId: string,
  predicate: (snapshot: NativeReminderSnapshot) => boolean,
  timeoutMs = 30_000,
): Promise<NativeReminderSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: NativeReminderSnapshot | null = null;

  while (Date.now() < deadline) {
    const snapshot = await readReminderById(reminderId);
    if (snapshot) {
      lastSnapshot = snapshot;
      if (predicate(snapshot)) {
        return snapshot;
      }
    }
    await sleep(1_000);
  }

  throw new Error(
    `Timed out waiting for native reminder ${reminderId}. Last snapshot: ${JSON.stringify(lastSnapshot)}`,
  );
}

async function waitForReminderDeletion(
  reminderId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readReminderById(reminderId);
    if (!snapshot) {
      return;
    }
    await sleep(1_000);
  }
  throw new Error(
    `Timed out waiting for native reminder ${reminderId} deletion`,
  );
}

describeLive("native Apple reminders live integration", () => {
  it("creates, updates, and deletes a real reminder in Reminders.app", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const initialTitle = `Eliza live reminder ${suffix}`;
    const updatedTitle = `Eliza live reminder updated ${suffix}`;
    const createdDueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const updatedDueAt = new Date(
      Date.now() + 2 * 60 * 60 * 1000,
    ).toISOString();

    const created = await createNativeAppleReminderLikeItem({
      kind: "reminder",
      title: initialTitle,
      dueAt: createdDueAt,
      notes: "Created by the live macOS reminder test.",
      originalIntent: "live test create a reminder",
    });
    expect(created).toMatchObject({
      ok: true,
      data: { provider: "apple_reminders" },
    });
    const reminderId =
      created.ok === true ? (created.data.reminderId ?? null) : null;
    expect(reminderId).toBeTruthy();
    if (!reminderId) {
      throw new Error("Live native reminder test did not return a reminder id");
    }

    try {
      const initialSnapshot = await waitForReminder(
        reminderId,
        (snapshot) =>
          snapshot.title === initialTitle &&
          snapshot.body.includes("Created by the live macOS reminder test.") &&
          snapshot.body.includes("Eliza request: live test create a reminder"),
      );
      expect(initialSnapshot.dueText.length).toBeGreaterThan(0);

      const updated = await updateNativeAppleReminderLikeItem({
        reminderId,
        kind: "alarm",
        title: updatedTitle,
        dueAt: updatedDueAt,
        notes: "Updated by the live macOS reminder test.",
        originalIntent: "live test update the reminder",
      });
      expect(updated).toMatchObject({
        ok: true,
        data: { provider: "apple_reminders", reminderId },
      });

      const updatedSnapshot = await waitForReminder(
        reminderId,
        (snapshot) =>
          snapshot.title === updatedTitle &&
          snapshot.body.includes("Updated by the live macOS reminder test.") &&
          snapshot.body.includes(
            "Eliza request: live test update the reminder",
          ),
      );
      expect(updatedSnapshot.dueText.length).toBeGreaterThan(0);
    } finally {
      const deleted = await deleteNativeAppleReminderLikeItem(reminderId);
      expect(deleted).toMatchObject({
        ok: true,
        data: { provider: "apple_reminders" },
      });
      await waitForReminderDeletion(reminderId);
    }
  }, 120_000);
});
