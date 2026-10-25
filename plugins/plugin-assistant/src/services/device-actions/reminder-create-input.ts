/** Model-only relative input resolves before the existing absolute approval contract. */
import { parseDurationMs } from "@elizaos/core";
import { DeviceActionError, exactKeys, object } from "./contract.ts";
import { validateReminderCreate } from "./reminder-create-contract.ts";

export function resolveReminderCreateInput(
  value: unknown,
  startedAt: number,
): unknown {
  const operation = object(value);
  if (operation.type !== "reminder_create_after") return value;
  exactKeys(operation, ["type", "fields"]);
  const fields = object(operation.fields);
  exactKeys(fields, ["title", "body", "schedule"]);
  const schedule = object(fields.schedule);
  exactKeys(schedule, ["after", "alertMinutes"]);
  if (
    typeof schedule.after !== "string" ||
    !/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/.test(schedule.after) ||
    !Number.isSafeInteger(startedAt) ||
    startedAt < 0
  )
    throw new DeviceActionError(
      "Relative reminder requires a duration with units and an authenticated turn time",
    );
  let duration: number;
  try {
    duration = parseDurationMs(schedule.after);
  } catch {
    throw new DeviceActionError("Invalid relative reminder duration");
  }
  if (
    duration <= 0 ||
    (schedule.alertMinutes !== 0 && schedule.alertMinutes !== null)
  )
    throw new DeviceActionError(
      "Relative reminder requires a positive duration and an immediate alert or no alert",
    );
  const dueAt = startedAt + duration;
  if (dueAt <= Date.now())
    throw new DeviceActionError(
      "Relative reminder time has passed; request a new reminder",
    );
  try {
    return validateReminderCreate({
      type: "reminder_create",
      fields: {
        title: fields.title,
        body: fields.body,
        schedule: {
          at: dueAt,
          dueAt,
          alertMinutes: schedule.alertMinutes,
          recurrence: null,
        },
      },
    });
  } catch {
    throw new DeviceActionError("Invalid relative reminder fields or instant");
  }
}
