// spec/os/android/reminderAlarms.md, "Story: Get my reminder at its time, even after a reboot"
import type { PluginListenerHandle } from "@capacitor/core";
import type { DeletionMark, StoredStatus } from "../../../gen/os__android__reminderAlarms.ts";

export interface AndroidReminderTarget {
  sourceId: string;
  sourceRevision: string;
  reminderId: string;
  occurrenceId: string;
  revision: string;
  timingVersion?: 2;
}

export interface AndroidReminderRecurrence {
  rule: "daily" | "weekdays" | "weekly";
  zone: string;
  date: string;
  time: string;
  leadMinutes: number;
}

export type AndroidReminderTiming = { dueAt: number; alertMinutes: number | null } | { dueAt?: never; alertMinutes?: never };

export type AndroidReminderSchedule = AndroidReminderTiming & {
  at: number;
  recurrence: AndroidReminderRecurrence | null;
};

export interface AndroidReminderCreationSchedule {
  at: number;
  dueAt: number;
  alertMinutes: number | null;
  recurrence: AndroidReminderRecurrence | null;
}

export type AndroidReminderOperation =
  | { type: "reminder_create"; fields: { title: string; body: string; schedule: AndroidReminderCreationSchedule } }
  | { type: "reminder_update"; target: AndroidReminderTarget; fields: { title: string; body: string; schedule?: AndroidReminderSchedule } }
  | { type: "reminder_read_selected" | "reminder_complete" | "reminder_snooze" | "reminder_cancel"; target: AndroidReminderTarget };

export type AndroidReminderStatus =
  | "scheduled"
  | "pending"
  | "posted"
  | "permission-denied"
  | "scheduling-failed"
  | "completed"
  | "cancelled"
  | "todo";

interface AndroidReminderRecordBase {
  id: string;
  title: string;
  body: string;
  occurrenceId: string;
  target: AndroidReminderTarget;
  createdAt: number;
  recurrence?: AndroidReminderRecurrence;
  revision?: string;
  postedAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  snoozedAt?: number;
  legacyAlarm?: boolean;
  pendingDeletion?: string;
}

export type AndroidReminderRecord = AndroidReminderRecordBase &
  (
    | {
        undated: true;
        at?: never;
        dueAt?: never;
        alertMinutes?: never;
        status: "todo" | "completed" | "cancelled";
        mode: "none";
        history: Array<{ occurrenceId: string; completedAt: number }>;
      }
    | {
        undated?: false;
        at: number;
        dueAt: number;
        alertMinutes?: number | null;
        status: Exclude<AndroidReminderStatus, "todo">;
        mode: "inexact" | "none";
        history: Array<{ occurrenceId: string; dueAt: number; completedAt: number; skippedDates: number }>;
      }
  );

export type AndroidReminderResult = {
  version: 1;
  sourceId: string;
  reminderId: string;
  occurrenceId: string;
  revision: string;
  status: AndroidReminderStatus;
  at: number;
  dueAt?: number;
  alertMinutes?: number | null;
} & (
  | { kind: "reminder_create"; fields: { title: string; body: string; schedule: AndroidReminderCreationSchedule } }
  | { kind: "reminder_read_selected"; fields: { title: string; body: string; schedule: AndroidReminderSchedule } }
  | { kind: "reminder_update" | "reminder_complete" | "reminder_snooze" | "reminder_cancel" }
);

export type AndroidReminderReceipt =
  | { status: "succeeded"; result: AndroidReminderResult }
  | { status: "unknown"; result?: AndroidReminderResult; message?: string };

export interface AndroidReminderBoundOperation {
  operationId: string;
  bindingHash: string;
  operation: AndroidReminderOperation;
}

export interface AndroidReminderMessage {
  id: string;
  status: "failed" | "past" | "permission-denied" | "storage-full";
  mode: "inexact";
  message: string;
}

export type AndroidTodoSaveResult =
  | AndroidReminderMessage
  | { id: string; status: "saved"; mode: "none"; target: AndroidReminderTarget; message: string };

export type AndroidReminderScheduleResult =
  | AndroidReminderMessage
  | {
      id: string;
      status: "scheduled" | "pending";
      at: number;
      mode: "inexact" | "none";
      dueAt?: number;
      alertMinutes?: number | null;
      message: string;
    };

export type AndroidReminderPendingTap =
  | { token: string; target: AndroidReminderTarget; retained: boolean; question?: boolean }
  | { token?: never; target?: never; retained?: never; question?: never };

export type AndroidReminderScheduleInput = AndroidReminderTiming & {
  id: string;
  title: string;
  body?: string;
  at: number;
  recurrence?: AndroidReminderRecurrence | null;
};

export interface AndroidReminderCancelInput {
  id: string;
  target: AndroidReminderTarget;
  operationId: string;
  bindingHash: string;
}

export interface AndroidReminderCancelResult {
  id: string;
  status: "cancelled" | "unknown";
  mode: "inexact";
  message: string;
}

export interface AndroidTodoDecision {
  id: string;
  status: "todo" | "completed" | "cancelled";
  target: AndroidReminderTarget;
}

export interface AndroidReminderList {
  reminders: AndroidReminderRecord[];
  notificationsEnabled: boolean;
}

export interface AndroidRemindersPlugin {
  scheduleReminder(options: AndroidReminderScheduleInput): Promise<AndroidReminderScheduleResult>;
  listReminders(): Promise<AndroidReminderList>;
  selectedReminder(options: { id: string }): Promise<AndroidReminderTarget>;
  operateReminder(options: AndroidReminderBoundOperation): Promise<AndroidReminderReceipt>;
  reminderOperationReceipt(options: AndroidReminderBoundOperation): Promise<AndroidReminderReceipt>;
  reminderDecision(options: {
    id: string;
    occurrenceId: string;
    action: "done" | "snooze";
  }): Promise<{ status: AndroidReminderStatus | "stale" | "unchanged" } | AndroidReminderMessage>;
  cancelReminder(options: AndroidReminderCancelInput): Promise<AndroidReminderCancelResult>;
  saveTodo(options: { id: string; title: string; body?: string }): Promise<AndroidTodoSaveResult>;
  todoDecision(options: { target: AndroidReminderTarget; action: "done" | "reopen" | "cancel" }): Promise<AndroidTodoDecision>;
  pendingReminderTap(): Promise<AndroidReminderPendingTap>;
  consumeReminderTap(options: { token: string }): Promise<void>;
  releaseReminderQuestion(options: { token: string }): Promise<void>;
  dismissReminderTap(options: { token: string }): Promise<void>;
  addListener(eventName: "appResumed" | "pendingReminderTap", listener: () => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: "reminderOpened",
    listener: (event: { id: string; occurrenceId?: string | null }) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export type ReminderAction = "schedule" | "cancel";

export type ReminderStanding =
  | { kind: "Absent" }
  | { kind: "Untimed" }
  | { kind: "Stored"; status: StoredStatus; deletion: DeletionMark };

export interface RemindersClient {
  schedule(input: AndroidReminderScheduleInput): Promise<AndroidReminderScheduleResult>;
  list(): Promise<AndroidReminderList>;
  selected(id: string): Promise<AndroidReminderTarget>;
  operate(bound: AndroidReminderBoundOperation): Promise<AndroidReminderReceipt>;
  operationReceipt(bound: AndroidReminderBoundOperation): Promise<AndroidReminderReceipt>;
  cancel(input: AndroidReminderCancelInput): Promise<AndroidReminderCancelResult>;
  saveTodo(input: { id: string; title: string; body?: string }): Promise<AndroidTodoSaveResult>;
  todoDecision(input: { target: AndroidReminderTarget; action: "done" | "reopen" | "cancel" }): Promise<AndroidTodoDecision>;
  pendingTap(): Promise<AndroidReminderPendingTap>;
  consumeTap(token: string): Promise<void>;
  releaseQuestion(token: string): Promise<void>;
  dismissTap(token: string): Promise<void>;
}

export interface RemindersClientOptions {
  plugin?: AndroidRemindersPlugin;
  name?: string;
}
