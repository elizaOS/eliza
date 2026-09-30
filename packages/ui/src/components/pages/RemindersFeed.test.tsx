// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  canSnoozeReminder,
  ReminderEditor,
  RemindersFeed,
  type RemindersFeedHandle,
  reminderDeliveryLabel,
} from "./RemindersFeed";

vi.mock("../../state/TranslationContext.hooks", () => {
  const t = (key: string) =>
    ({
      "common.reminders": "Reminders",
      "common.refresh": "Refresh",
      "common.save": "Save",
      "common.back": "Back",
      "automationsreminders.loadFailed":
        "Could not load reminders. Refresh to try again.",
      "automationsreminders.unavailable":
        "Reminders are unavailable on this agent. Choose an agent with reminders enabled, then refresh.",
      "automationsreminders.editMessage": "Edit message",
      "automationsreminders.cancel": "Cancel reminder",
      "automationsreminders.snooze": "Snooze 10 minutes",
      "automationsreminders.message": "Reminder message",
      "automationsreminders.dueTime": "Due time",
      "automationsreminders.status.scheduled": "Scheduled",
      "automationsreminders.empty": "No reminders yet. Ask in chat to set one.",
    })[key] ?? key;
  return { useTranslation: () => ({ t }) };
});
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../api", () => ({
  client: { getBaseUrl: () => "http://agent", rawRequest: mocks.fetch },
}));
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
  fireEvent.click(screen.getByRole("button", { name: "Call dentist" }));
  expect(screen.getByText("Scheduled")).toBeTruthy();
  expect(screen.getByText(/Wednesday/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Snooze 10 minutes" }));
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/lifeops/occurrences/occ-1/snooze",
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
      "/api/lifeops/definitions/reminder-1",
      expect.objectContaining({ method: "PUT", body: '{"status":"archived"}' }),
    ),
  );
});
it("keeps failed loads visible rather than pretending no reminders exist", async () => {
  mocks.fetch.mockResolvedValue(new Response("", { status: 503 }));
  render(<RemindersFeed />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Could not load reminders",
  );
  expect(
    screen.queryByText("No reminders yet. Ask in chat to set one."),
  ).toBeNull();
});

afterEach(cleanup);
it("edits the saved message and one-time due date without creating another reminder", async () => {
  render(<RemindersFeed />);
  await screen.findByText("Call dentist");
  fireEvent.click(screen.getByRole("button", { name: "Call dentist" }));
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
  if (!call) throw Error("Reminder update missing");
  expect(JSON.parse(call[1].body).cadence.dueAt).toBe(
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
it.each(["delivered", "delivered_read"])(
  "snoozes a %s reminder through the same occurrence API",
  async (outcome) => {
    const delivered = {
      ...row,
      occurrence: { ...row.occurrence, state: "visible", metadata: {} },
      latestAttempt: { outcome },
    };
    mocks.fetch.mockImplementation(
      async (_url, init) =>
        new Response(
          JSON.stringify(
            init.method === "GET" ? { reminders: [delivered] } : {},
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    render(<RemindersFeed />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Call dentist" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Snooze 10 minutes" }));
    await waitFor(() =>
      expect(mocks.fetch).toHaveBeenCalledWith(
        "/api/lifeops/occurrences/occ-1/snooze",
        expect.objectContaining({ method: "POST", body: '{"minutes":10}' }),
      ),
    );
    expect(
      mocks.fetch.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
  },
);
it.each(["pending", "visible", "snoozed"])(
  "allows an eligible %s occurrence regardless of its delivered/read receipt",
  (state) => {
    for (const outcome of ["delivered", "delivered_read"]) {
      const value = {
        ...row,
        occurrence: { ...row.occurrence, state },
        latestAttempt: { outcome },
      } as never;
      expect(canSnoozeReminder(value)).toBe(true);
    }
  },
);
it("keeps explicit acknowledgement, inactive definitions and absent occurrences ineligible", () => {
  expect(
    canSnoozeReminder({
      ...row,
      occurrence: {
        ...row.occurrence,
        metadata: { reminderAcknowledgedAt: "2026-09-30T15:01:00Z" },
      },
    } as never),
  ).toBe(false);
  for (const status of ["archived", "paused", "completed"])
    expect(
      canSnoozeReminder({
        ...row,
        definition: { ...row.definition, status },
      } as never),
    ).toBe(false);
  expect(canSnoozeReminder({ ...row, occurrence: null } as never)).toBe(false);
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

it("creates one in-app reminder through the existing definition API with retry identity", async () => {
  const saved = vi.fn();
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ definition: { id: "created-reminder" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  render(<ReminderEditor onSaved={saved} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Reminder message"), {
    target: { value: "Drink water" },
  });
  fireEvent.change(screen.getByLabelText(/Due time/), {
    target: { value: "2030-10-01T12:30" },
  });
  const form = screen
    .getByRole("button", { name: "common.create" })
    .closest("form");
  if (!form) throw Error("Reminder form missing");
  fireEvent.submit(form);
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe("/api/lifeops/definitions");
  const payload = JSON.parse(init.body);
  expect(payload).toMatchObject({
    title: "Drink water",
    kind: "habit",
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
    cadence: { kind: "once", visibilityLeadMinutes: 0 },
    reminderPlan: { steps: [{ channel: "in_app", offsetMinutes: 0 }] },
  });
  expect(payload.idempotencyKey).toBeTruthy();
  expect(payload.timezone).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});

it("keeps cadence unchanged when only editing a snoozed reminder message", async () => {
  mocks.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        reminders: [
          {
            ...row,
            occurrence: {
              ...row.occurrence,
              state: "snoozed",
              snoozedUntil: "2030-11-03T09:30:42.123Z",
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  render(<RemindersFeed />);
  await screen.findByText("Call dentist");
  fireEvent.click(screen.getByRole("button", { name: "Call dentist" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
  fireEvent.change(screen.getByLabelText("Reminder message"), {
    target: { value: "Call clinic" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      mocks.fetch.mock.calls.some(([, init]) => init.method === "PUT"),
    ).toBe(true),
  );
  const call = mocks.fetch.mock.calls.find(([, init]) => init.method === "PUT");
  if (!call) throw Error("Missing update");
  expect(JSON.parse(call[1].body)).toEqual({ title: "Call clinic" });
});
it("retries an uncertain creation with the identical request and locked fields", async () => {
  mocks.fetch.mockRejectedValueOnce(Error("connection lost"));
  mocks.fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ definition: { id: "created-reminder" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const saved = vi.fn();
  render(<ReminderEditor onSaved={saved} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Reminder message"), {
    target: { value: "Drink water" },
  });
  fireEvent.change(screen.getByLabelText(/Due time/), {
    target: { value: "2030-10-01T12:30" },
  });
  fireEvent.click(screen.getByRole("button", { name: "common.create" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Reminder message")).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "common.create" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mocks.fetch.mock.calls[0][1].body).toEqual(
    mocks.fetch.mock.calls[1][1].body,
  );
});
it("does not complete a creation editor after it unmounts", async () => {
  let resolveRequest: ((value: Response) => void) | undefined;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      }),
  );
  const saved = vi.fn();
  const view = render(<ReminderEditor onSaved={saved} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Reminder message"), {
    target: { value: "Drink water" },
  });
  fireEvent.change(screen.getByLabelText(/Due time/), {
    target: { value: "2030-10-01T12:30" },
  });
  fireEvent.click(screen.getByRole("button", { name: "common.create" }));
  view.unmount();
  if (!resolveRequest) throw Error("Request not dispatched");
  resolveRequest(
    new Response(JSON.stringify({ definition: { id: "created-reminder" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(saved).not.toHaveBeenCalled();
});

it("shows actionable unavailable copy instead of a raw protocol code or false empty list", async () => {
  mocks.fetch.mockResolvedValue(new Response("", { status: 501 }));
  render(<RemindersFeed />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Choose an agent with reminders enabled",
  );
  expect(screen.queryByText(/501/)).toBeNull();
  expect(
    screen.queryByText("No reminders yet. Ask in chat to set one."),
  ).toBeNull();
});

it("keeps reminder controls behind an accessible disclosure without a nested heading or refresh", async () => {
  render(<RemindersFeed />);
  const summary = await screen.findByRole("button", { name: "Call dentist" });
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("heading", { name: "Reminders" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Snooze 10 minutes" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel reminder" })).toBeNull();
  fireEvent.click(summary);
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  const details = document.getElementById(
    summary.getAttribute("aria-controls") ?? "",
  );
  expect(details?.textContent).toContain("Wednesday");
  expect(details?.textContent).toContain("UTC");
  expect(details?.querySelector("time")?.getAttribute("datetime")).toBe(
    "2026-09-30T15:00:00Z",
  );
  expect(screen.getByRole("button", { name: "Edit message" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Snooze 10 minutes" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel reminder" })).toBeTruthy();
  fireEvent.click(summary);
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
});

it("keeps the latest refresh rows and counts when an older reminder read resolves late", async () => {
  let resolveOld: ((response: Response) => void) | undefined;
  mocks.fetch.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        resolveOld = resolve;
      }),
  );
  mocks.fetch.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        reminders: [
          {
            ...row,
            definition: { ...row.definition, title: "Current reminder" },
          },
        ],
      }),
      { status: 200 },
    ),
  );
  const ref = createRef<RemindersFeedHandle>();
  const counts = vi.fn();
  render(<RemindersFeed ref={ref} onCountsChange={counts} />);
  await act(async () => {
    await ref.current?.refresh();
  });
  await screen.findByText("Current reminder");
  if (!resolveOld) throw Error("Original read was not dispatched");
  await act(async () => {
    resolveOld?.(
      new Response(JSON.stringify({ reminders: [row, row] }), { status: 200 }),
    );
  });
  expect(screen.queryByText("Call dentist")).toBeNull();
  expect(counts).toHaveBeenLastCalledWith({ all: 1, active: 1, inactive: 0 });
});

it("does not restart a reminder read or update counts after an unmounted mutation completes", async () => {
  const counts = vi.fn();
  let finishMutation: ((value: Response) => void) | undefined;
  mocks.fetch.mockImplementation(async (_url, init) => {
    if (init.method === "PUT")
      return new Promise<Response>((resolve) => {
        finishMutation = resolve;
      });
    return new Response(JSON.stringify({ reminders: [row] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const view = render(<RemindersFeed onCountsChange={counts} />);
  await screen.findByText("Call dentist");
  fireEvent.click(screen.getByRole("button", { name: "Call dentist" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reminder" }));
  view.unmount();
  const countCalls = counts.mock.calls.length;
  await act(async () => {
    finishMutation?.(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await Promise.resolve();
  });
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(counts).toHaveBeenCalledTimes(countCalls);
});
