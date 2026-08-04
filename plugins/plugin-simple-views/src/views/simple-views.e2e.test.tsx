/**
 * Drives planner-visible Notes and Calendar capabilities into the real React
 * views through one filesystem-backed service, including view switches.
 *
 * @vitest-environment jsdom
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportFetch = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui/api/csrf-client", () => ({
  fetchWithCsrf: transportFetch,
}));

vi.mock("@elizaos/ui/api", () => ({
  client: { onWsEvent: vi.fn(() => () => undefined) },
}));

vi.mock("@elizaos/ui/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/ui/events")>();
  return { ...actual, useViewEvent: vi.fn() };
});

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

function activeService(): SimpleViewsService {
  if (!service) throw new Error("Simple Views E2E service is unavailable.");
  return service;
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
      const currentService = activeService();
      if (url === "/api/simple-views/state") {
        return jsonResponse({ success: true, data: currentService.snapshot() });
      }
      if (url.startsWith("/api/views/") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          capability: string;
          params?: Record<string, unknown>;
        };
        const result = await interactWithService(
          body.capability,
          body.params,
          currentService,
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

describe("Simple Views capability-to-UI journey", () => {
  it("projects note and event mutations across read-only view switches", async () => {
    const notes = render(<NotesView />);
    expect(
      await screen.findByRole("main", {
        name: "Notes. 0 notes · revision 0",
      }),
    ).toBeTruthy();
    expect(
      notes.container.querySelector("button, input, textarea, form"),
    ).toBeNull();
    notes.unmount();

    await interactWithService(
      "create-note",
      {
        title: "Demo briefing",
        body: "Show Calendar and Notes together",
        color: "green",
      },
      activeService(),
    );
    await interactWithService(
      "update-note",
      { query: "Demo briefing", newTitle: "Demo briefing ready" },
      activeService(),
    );

    const populatedNotes = render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();
    expect(screen.getByText("Show Calendar and Notes together")).toBeTruthy();
    expect(
      populatedNotes.container.querySelector("button, input, textarea, form"),
    ).toBeNull();
    populatedNotes.unmount();

    await interactWithService(
      "select-calendar-date",
      { date: "2026-08-12" },
      activeService(),
    );
    await interactWithService(
      "create-calendar-event",
      {
        title: "Cloud review",
        date: "2026-08-12",
        time: "15:00",
        notes: "Verify the signed native build",
        color: "green",
      },
      activeService(),
    );

    const calendar = render(<SimpleCalendarView />);
    expect(
      await screen.findByRole("main", {
        name: "Calendar. 1 event · revision 4",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "August 2026" })).toBeTruthy();
    expect(await screen.findByText("Cloud review")).toBeTruthy();
    expect(screen.getByText("Verify the signed native build")).toBeTruthy();
    expect(
      calendar.container.querySelector("button, input, textarea, form"),
    ).toBeNull();

    calendar.unmount();
    render(<NotesView />);
    expect(await screen.findByText("Demo briefing ready")).toBeTruthy();

    await waitFor(() => {
      expect(activeService().snapshot()).toMatchObject({
        revision: 4,
        selectedDate: "2026-08-12",
        notes: [{ title: "Demo briefing ready", color: "green" }],
        events: [
          {
            title: "Cloud review",
            date: "2026-08-12",
            time: "15:00",
          },
        ],
      });
    });
  });
});
