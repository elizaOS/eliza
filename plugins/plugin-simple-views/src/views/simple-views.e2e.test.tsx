/**
 * Drives the real Notes and Calendar React surfaces through the production
 * browser contracts into one filesystem-backed service, including view switches.
 *
 * @vitest-environment jsdom
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportFetch = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/api/csrf-client", () => ({
  fetchWithCsrf: transportFetch,
}));

vi.mock("@elizaos/ui/api", () => ({
  client: { onWsEvent: vi.fn(() => () => undefined) },
}));

vi.mock("@elizaos/ui/events", () => ({
  useViewEvent: vi.fn(),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: (definition: { id: string; label: string }) => ({
    ref: { current: null },
    agentProps: {
      "aria-label": definition.label,
      "data-agent-id": definition.id,
    },
  }),
}));

import { interact as interactWithService } from "../interact.js";
import { SimpleViewsService } from "../service.js";
import { NotesView } from "./NotesView.js";
import { SimpleCalendarView } from "./SimpleCalendarView.js";

let service: SimpleViewsService | null = null;
let stateDirectory = "";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "simple-views-ui-e2e-"),
  );
  let id = 0;
  let timestamp = Date.parse("2026-07-22T12:00:00.000Z");
  service = new SimpleViewsService(undefined, {
    stateDir: stateDirectory,
    createId: (kind) => `${kind}-e2e-${++id}`,
    now: () => new Date(timestamp++),
  });
  await service.initialize();

  transportFetch.mockReset();
  transportFetch.mockImplementation(
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (!service) throw new Error("Simple Views E2E service is unavailable.");
      if (url === "/api/simple-views/state") {
        return jsonResponse({ success: true, data: service.snapshot() });
      }
      if (url.startsWith("/api/views/") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          capability: string;
          params?: Record<string, unknown>;
        };
        const result = await interactWithService(
          body.capability,
          body.params,
          service,
        );
        return jsonResponse({
          requestId: `simple-views-e2e-${body.capability}`,
          success: result.success,
          result,
        });
      }
      return jsonResponse({ error: `Unexpected E2E URL: ${url}` }, 404);
    },
  );
});

afterEach(async () => {
  cleanup();
  await service?.stop();
  service = null;
  await fs.rm(stateDirectory, { recursive: true, force: true });
});

describe("Simple Views deterministic UI-to-service journey", () => {
  it("creates, edits, and preserves a note while creating an event across view switches", async () => {
    const notes = render(<NotesView />);
    expect(
      await screen.findByRole("main", {
        name: "Notes. 0 notes · revision 0",
      }),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "Demo briefing" },
    });
    fireEvent.change(screen.getByLabelText("Note details"), {
      target: { value: "Show Calendar and Notes together" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use green color" }));
    fireEvent.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByText("Demo briefing")).toBeTruthy();
    expect(screen.getByText("Show Calendar and Notes together")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Edit note Demo briefing" }),
    );
    fireEvent.change(screen.getByLabelText("Note title"), {
      target: { value: "Demo briefing ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note changes" }));
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();

    notes.unmount();
    const calendar = render(<SimpleCalendarView />);
    expect(
      await screen.findByRole("main", {
        name: "Calendar. 0 events · revision 2",
      }),
    ).toBeTruthy();
    const selectedDate = service?.snapshot().selectedDate;
    if (!selectedDate) throw new Error("Calendar selected date is required.");

    fireEvent.change(screen.getByLabelText("Calendar event title"), {
      target: { value: "Cloud review" },
    });
    fireEvent.change(screen.getByLabelText("Calendar event date"), {
      target: { value: selectedDate },
    });
    fireEvent.change(screen.getByLabelText("Calendar event time"), {
      target: { value: "15:00" },
    });
    fireEvent.change(screen.getByLabelText("Calendar event details"), {
      target: { value: "Verify the signed native build" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create calendar event" }),
    );
    expect(await screen.findByText("Cloud review")).toBeTruthy();
    expect(screen.getByText("Verify the signed native build")).toBeTruthy();

    calendar.unmount();
    render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();

    await waitFor(() => {
      expect(service?.snapshot()).toMatchObject({
        revision: 3,
        notes: [{ title: "Demo briefing ready", color: "green" }],
        events: [
          {
            title: "Cloud review",
            date: selectedDate,
            time: "15:00",
          },
        ],
      });
    });
  });
});
