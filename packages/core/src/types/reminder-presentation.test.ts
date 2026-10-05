import { expect, it, vi } from "vitest";

it("shares issued authority across separately loaded core copies and rejects serialized forgeries", async () => {
	const first = await import("./reminder-presentation");
	const token = first.createReminderPresentation(
		"Reminder: exact",
		"Reminder: exact",
		"Reminder",
	);
	vi.resetModules();
	const second = await import("./reminder-presentation");
	expect(second.readReminderPresentation(token)).toBe(token);
	expect(
		second.readReminderPresentation(JSON.parse(JSON.stringify(token))),
	).toBeNull();
	expect(() =>
		first.createReminderPresentation("body", "different", "title"),
	).toThrow(expect.objectContaining({ code: "REMINDER_PRESENTATION_INVALID" }));
});
