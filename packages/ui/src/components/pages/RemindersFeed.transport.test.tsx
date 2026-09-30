// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReminderEditor, RemindersFeed } from "./RemindersFeed";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../api", async () => {
  const { ElizaClient } = await import("../../api/client-base");
  const client = new ElizaClient("eliza-remote://session/reminder-relay");
  client.setRequestTransport({ request: mocks.request });
  return { client };
});
vi.mock("../../state/TranslationContext.hooks", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.save": "Save",
        "automationsreminders.editMessage": "Edit message",
        "automationsreminders.message": "Reminder message",
        "automationsreminders.dueTime": "Due time",
        "automationsreminders.cancel": "Cancel reminder",
      })[key] ?? key,
  }),
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
  mocks.request.mockReset();
  mocks.request.mockImplementation(
    async (_url, init) =>
      new Response(
        JSON.stringify(init.method === "GET" ? { reminders: [row] } : {}),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Browser fetch cannot address a paired relay session");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("loads and edits paired reminders through the installed client transport", async () => {
  render(<RemindersFeed />);
  await screen.findByText("Call dentist", {}, { timeout: 10000 });
  fireEvent.click(screen.getByRole("button", { name: "Call dentist" }));
  expect(mocks.request).toHaveBeenCalledWith(
    "eliza-remote://session/reminder-relay/api/lifeops/reminders",
    expect.objectContaining({ method: "GET" }),
    expect.anything(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
  fireEvent.change(screen.getByLabelText("Reminder message"), {
    target: { value: "Call clinic" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(
    () =>
      expect(
        mocks.request.mock.calls.some(
          ([url, init]) =>
            url.endsWith("/definitions/reminder-1") &&
            init.method === "PUT" &&
            JSON.parse(init.body).title === "Call clinic",
        ),
      ).toBe(true),
    { timeout: 10000 },
  );
  await waitFor(
    () =>
      expect(
        screen.getByRole("button", { name: "Cancel reminder" }),
      ).toHaveProperty("disabled", false),
    { timeout: 10000 },
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel reminder" }));
  await waitFor(
    () =>
      expect(
        mocks.request.mock.calls.some(
          ([url, init]) =>
            url.endsWith("/definitions/reminder-1") &&
            init.method === "PUT" &&
            JSON.parse(init.body).status === "archived",
        ),
      ).toBe(true),
    { timeout: 10000 },
  );
  expect(fetch).not.toHaveBeenCalled();
}, 60000);

it("creates a manual reminder through the installed paired relay transport", async () => {
  const saved = vi.fn();
  mocks.request.mockResolvedValueOnce(
    new Response(JSON.stringify({ definition: { id: "created-reminder" } }), {
      status: 201,
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
  fireEvent.click(screen.getByRole("button", { name: "common.create" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  const [url, init] = mocks.request.mock.calls[0];
  expect(url).toBe(
    "eliza-remote://session/reminder-relay/api/lifeops/definitions",
  );
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toMatchObject({
    title: "Drink water",
    cadence: { kind: "once", visibilityLeadMinutes: 0 },
    metadata: {
      ownerSurface: "OWNER_REMINDERS",
      nativeProjection: "in_app_only",
    },
    reminderPlan: { steps: [{ channel: "in_app", offsetMinutes: 0 }] },
  });
  expect(JSON.parse(init.body).idempotencyKey).toBeTruthy();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
