// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canSnoozeReminder,
  RemindersFeed,
  reminderDeliveryLabel,
} from "./RemindersFeed";

vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.reminders": "Reminders",
        "common.refresh": "Refresh",
        "common.save": "Save",
        "common.back": "Back",
        "automationsreminders.editMessage": "Edit message",
        "automationsreminders.cancel": "Cancel reminder",
        "automationsreminders.snooze": "Snooze 10 minutes",
        "automationsreminders.message": "Reminder message",
        "automationsreminders.dueTime": "Due time",
        "automationsreminders.status.scheduled": "Scheduled",
        "automationsreminders.empty":
          "No reminders yet. Ask in chat to set one.",
      })[key] ?? key,
  }),
}));
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../api", () => ({ client: { getBaseUrl: () => "http://agent" } }));
vi.mock("../../api/csrf-client", () => ({ fetchWithCsrf: mocks.fetch }));
const row = {
  definition: {
    id: "reminder-1",
    title: "Call dentist",
    description: "",
    status: "active",
    timezone: "UTC",
    cadence: { kind: "once", dueAt: "2026-09-30T15:00:00Z" },
  },
  occurrence: { id: "occ-1", dueAt: "2026-09-30T15:00:00Z", state: "pending" },
  latestAttempt: null,
};
beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(
    async (_url, init) =>
      new Response(
        JSON.stringify(init.method === "GET" ? { reminders: [row] } : {}),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
});
it("shows exact reminder and uses existing snooze/cancel verbs", async () => {
  render(<RemindersFeed />);
  await screen.findByText("Call dentist");
  expect(screen.getByText("Scheduled")).toBeTruthy();
  expect(screen.getByText(/Wednesday/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Snooze 10 minutes" }));
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://agent/api/lifeops/occurrences/occ-1/snooze",
      expect.objectContaining({ method: "POST", body: '{"minutes":10}' }),
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Cancel reminder" }),
    ).toHaveProperty("disabled", false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel reminder" }));
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://agent/api/lifeops/definitions/reminder-1",
      expect.objectContaining({ method: "PUT", body: '{"status":"archived"}' }),
    ),
  );
});
it("keeps failed loads visible rather than pretending no reminders exist", async () => {
  mocks.fetch.mockResolvedValue(new Response("", { status: 503 }));
  render(<RemindersFeed />);
  expect((await screen.findByRole("alert")).textContent).toContain("503");
  expect(
    screen.queryByText("No reminders yet. Ask in chat to set one."),
  ).toBeNull();
});

afterEach(cleanup);
it("edits the saved message and one-time due date without creating another reminder", async () => {
  render(<RemindersFeed />);
  await screen.findByText("Call dentist");
  fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
  fireEvent.change(screen.getByLabelText("Reminder message"), {
    target: { value: "Call clinic" },
  });
  const due = screen.getByLabelText(/Due time/);
  fireEvent.change(due, { target: { value: "2026-10-01T12:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      mocks.fetch.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("definitions/reminder-1") &&
          init.method === "PUT" &&
          JSON.parse(init.body).title === "Call clinic",
      ),
    ).toBe(true),
  );
  const call = mocks.fetch.mock.calls.find(([, init]) => init.method === "PUT");
  expect(JSON.parse(call![1].body).cadence.dueAt).toBe(
    new Date("2026-10-01T12:30").toISOString(),
  );
  expect(
    mocks.fetch.mock.calls.some(([, init]) => init.method === "POST"),
  ).toBe(false);
});

it.each(["completed", "skipped", "expired", "muted"])(
  "shows terminal occurrence %s without scheduling or snooze claims",
  (state) => {
    const value = { ...row, occurrence: { ...row.occurrence, state } } as never;
    expect(reminderDeliveryLabel(value)).toBe(state);
    expect(canSnoozeReminder(value)).toBe(false);
  },
);
it("does not offer unproven redelivery snooze on a delivered reminder", () => {
  const value = { ...row, latestAttempt: { outcome: "delivered" } } as never;
  expect(reminderDeliveryLabel(value)).toBe("delivered");
  expect(canSnoozeReminder(value)).toBe(false);
});
it("does not label unrecognized delivery failures as Scheduled", () => {
  expect(
    reminderDeliveryLabel({
      ...row,
      latestAttempt: { outcome: "failed" },
    } as never),
  ).toBe("unknown");
  expect(
    reminderDeliveryLabel({
      ...row,
      latestAttempt: { outcome: "skipped_duplicate" },
    } as never),
  ).toBe("duplicate");
});
