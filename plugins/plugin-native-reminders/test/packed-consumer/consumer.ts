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
