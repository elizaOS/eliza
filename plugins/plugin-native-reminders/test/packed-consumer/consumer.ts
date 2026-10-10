import {
  type AndroidReminderBoundOperation,
  type AndroidReminderReceipt,
  registerAndroidReminders,
} from "@elizaos/macosreminders/android";

const bridge = registerAndroidReminders("ExternalHostReminders");
const creation: AndroidReminderBoundOperation = {
  operationId: "new-reminder",
  bindingHash: "a".repeat(64),
  operation: {
    type: "reminder_create",
    fields: {
      title: "Review",
      body: "",
      schedule: {
        at: 2000000000000,
        dueAt: 2000000000000,
        alertMinutes: null,
        recurrence: null,
      },
    },
  },
};
const receipt: Promise<AndroidReminderReceipt> =
  bridge.operateReminder(creation);
void receipt;
// @ts-expect-error Explicit timing requires dueAt and alertMinutes together.
bridge.scheduleReminder({
  id: "x",
  title: "Review",
  at: 2000000000000,
  dueAt: 2000000000000,
});
// @ts-expect-error Cancellation requires the reviewed target and durable binding.
bridge.cancelReminder({ id: "x" });
// @ts-expect-error Only native decision actions are accepted.
bridge.reminderDecision({ id: "x", occurrenceId: "y", action: "delete" });
const missingPolicy: AndroidReminderBoundOperation = {
  operationId: "new-reminder",
  bindingHash: "a",
  operation: {
    type: "reminder_create",
    fields: {
      title: "Review",
      body: "",
      // @ts-expect-error Creation must explicitly specify alert policy.
      schedule: { at: 1, recurrence: null },
    },
  },
};
void missingPolicy;
async function read() {
  const result = await bridge.operateReminder(creation);
  if (result.status === "succeeded") {
    const revision: string = result.result.revision;
    void revision;
  }
  // @ts-expect-error An unknown outcome need not have a result.
  const unsafe: string = result.result.revision;
  void unsafe;
  const tap = await bridge.pendingReminderTap();
  if (tap.token) await bridge.consumeReminderTap({ token: tap.token });
}
void read;

async function readTasks() {
  const { reminders } = await bridge.listReminders();
  for (const record of reminders) {
    if (record.undated) {
      const noAlarm: "none" = record.mode;
      // @ts-expect-error An undated to-do has no due time.
      const date: number = record.dueAt;
      void [noAlarm, date];
      await bridge.todoDecision({ target: record.target, action: "done" });
    } else {
      const date: number = record.dueAt;
      void date;
    }
    // @ts-expect-error Inspect undated before using the timestamp.
    const assumedTime: number = record.at;
    void assumedTime;
  }
  await bridge.saveTodo({ id: "todo", title: "Undated task" });
}
void readTasks;
