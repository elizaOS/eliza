/**
 * Mounts only the production Calendar surface for focused visual audits.
 * Keeping this entry separate prevents unrelated view imports from blocking a
 * calendar release certificate when another fixture is under construction.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CalendarPage } from "../../../../plugins/plugin-calendar/src/components/calendar/CalendarPage.tsx";
import { VIEW_SPECS } from "./fixtures.ts";

declare global {
  interface Window {
    __VIEW_HARNESS_READY__?: boolean;
    __VIEW_HARNESS_ERROR__?: string;
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state") ?? "empty";
  const mode = params.get("mode") ?? "week";
  const calendar = VIEW_SPECS.calendar;
  if (!calendar.states.includes(state)) {
    throw new Error(`Unknown Calendar state "${state}"`);
  }

  globalThis.__VIEW_HARNESS_COMPACT__ = params.get("compact") === "1";
  const result = calendar.calendarResultFor?.(state);
  globalThis.__VIEW_HARNESS_CALENDAR__ = {
    ...result,
    viewMode: mode,
  } as typeof globalThis.__VIEW_HARNESS_CALENDAR__;
  globalThis.__VIEW_HARNESS_CALENDAR_SOURCES__ =
    calendar.calendarSourcesResultFor?.(
      state,
    ) as typeof globalThis.__VIEW_HARNESS_CALENDAR_SOURCES__;

  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");
  createRoot(root).render(
    <StrictMode>
      <CalendarPage />
    </StrictMode>,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.__VIEW_HARNESS_READY__ = true;
}

main().catch((error: unknown) => {
  window.__VIEW_HARNESS_ERROR__ =
    error instanceof Error ? error.stack || error.message : String(error);
});
