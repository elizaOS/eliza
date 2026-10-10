import type { PluginListenerHandle } from "@capacitor/core";

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
/** Epoch milliseconds. Explicit null disables alerts; omission is legacy timing. */
export type AndroidReminderTiming =
  | { dueAt: number; alertMinutes: number | null }
  | { dueAt?: never; alertMinutes?: never };
export type AndroidReminderSchedule = AndroidReminderTiming & {
  at: number;
  recurrence: AndroidReminderRecurrence | null;
};
export type AndroidReminderCreationSchedule = {
  at: number;
  dueAt: number;
  alertMinutes: number | null;
  recurrence: AndroidReminderRecurrence | null;
};
export type AndroidReminderOperation =
  | {
      type: "reminder_create";
      fields: {
        title: string;
        body: string;
        schedule: AndroidReminderCreationSchedule;
      };
    }
  | {
      type: "reminder_update";
      target: AndroidReminderTarget;
      fields: {
        title: string;
        body: string;
        schedule?: AndroidReminderSchedule;
      };
    }
  | {
      type:
        | "reminder_read_selected"
        | "reminder_complete"
        | "reminder_snooze"
        | "reminder_cancel";
      target: AndroidReminderTarget;
    };
export type AndroidReminderStatus =
  | "scheduled"
  | "pending"
  | "posted"
  | "permission-denied"
  | "scheduling-failed"
  | "completed"
  | "cancelled"
  /** Undated to-do (reminderTodoVersion 1): no instant, alarm or notification. */
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
}
/** Narrow on undated before using reminder timestamps or alert history. */
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
        history: Array<{
          occurrenceId: string;
          dueAt: number;
          completedAt: number;
          skippedDates: number;
        }>;
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
  | {
      kind: "reminder_create";
      fields: {
        title: string;
        body: string;
        schedule: AndroidReminderCreationSchedule;
      };
    }
  | {
      kind: "reminder_read_selected";
      fields: {
        title: string;
        body: string;
        schedule: AndroidReminderSchedule;
      };
    }
  | {
      kind:
        | "reminder_update"
        | "reminder_complete"
        | "reminder_snooze"
        | "reminder_cancel";
    }
);
/** Unknown must be reconciled; never blindly repeat an uncertain Android effect. */
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
  /** Stable refusal codes (reminderStatusVersion 1). storage-full is never reported as failed. */
  status: "failed" | "past" | "permission-denied" | "storage-full";
  mode: "inexact";
  message: string;
}
export type AndroidTodoSaveResult =
  | AndroidReminderMessage
  | {
      id: string;
      status: "saved";
      mode: "none";
      target: AndroidReminderTarget;
      message: string;
    };
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
  | { token: string; target: AndroidReminderTarget; retained: boolean }
  | { token?: never; target?: never; retained?: never };
/** Methods may reject; resolved unknown/failure statuses are not successful operations. */
export interface AndroidRemindersPlugin {
  scheduleReminder(
    options: AndroidReminderTiming & {
      id: string;
      title: string;
      body?: string;
      at: number;
      recurrence?: AndroidReminderRecurrence | null;
    },
  ): Promise<AndroidReminderScheduleResult>;
  listReminders(): Promise<{
    reminders: AndroidReminderRecord[];
    notificationsEnabled: boolean;
  }>;
  selectedReminder(options: { id: string }): Promise<AndroidReminderTarget>;
  operateReminder(
    options: AndroidReminderBoundOperation,
  ): Promise<AndroidReminderReceipt>;
  reminderOperationReceipt(
    options: AndroidReminderBoundOperation,
  ): Promise<AndroidReminderReceipt>;
  reminderDecision(options: {
    id: string;
    occurrenceId: string;
    action: "done" | "snooze";
  }): Promise<
    | { status: AndroidReminderStatus | "stale" | "unchanged" }
    | AndroidReminderMessage
  >;
  cancelReminder(options: {
    id: string;
    target: AndroidReminderTarget;
    operationId: string;
    bindingHash: string;
  }): Promise<{
    id: string;
    status: "cancelled" | "unknown";
    mode: "inexact";
    message: string;
  }>;
  /** Undated to-do; a retried save with the same ID and text is idempotent. */
  saveTodo(options: {
    id: string;
    title: string;
    body?: string;
  }): Promise<AndroidTodoSaveResult>;
  /** Rejects when the exact reviewed target changed. */
  todoDecision(options: {
    target: AndroidReminderTarget;
    action: "done" | "reopen" | "cancel";
  }): Promise<{
    id: string;
    status: "todo" | "completed" | "cancelled";
    target: AndroidReminderTarget;
  }>;
  pendingReminderTap(): Promise<AndroidReminderPendingTap>;
  consumeReminderTap(options: { token: string }): Promise<void>;
  dismissReminderTap(options: { token: string }): Promise<void>;
  addListener(
    eventName: "appResumed" | "pendingReminderTap",
    listener: () => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "reminderOpened",
    listener: (event: { id: string; occurrenceId?: string | null }) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
