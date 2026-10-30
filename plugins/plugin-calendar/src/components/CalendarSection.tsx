/** Canonical runtime binding for the shared controlled Calendar workspace. */
import type { LifeOpsCalendarEvent } from "@elizaos/contracts";
import { useAppSelector, useViewEvent, VIEW_EVENTS } from "@elizaos/ui";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { useCalendarWeek } from "../hooks/useCalendarWeek.js";
import { CalendarWorkspace } from "./CalendarWorkspace.js";
import { EventEditorDrawer } from "./EventEditorDrawer.js";

export interface CalendarSectionProps {
  /** Currently-selected event id, owned by the host shell. */
  selectedEventId: string | null;
  /** Notify the host shell that the selected event id changed. */
  onSelectEvent: (eventId: string | null) => void;
  /** Launch a chat about the given event when the embedding host owns that flow. */
  onChatAboutEvent?: (event: LifeOpsCalendarEvent) => void;
  /**
   * Resolve an event that was primed by the host shell (e.g. a deep link or
   * widget row) but is outside the currently-loaded feed window.
   */
  getPrimedEvent: (id: string) => LifeOpsCalendarEvent | null;
}

export function CalendarSection({
  selectedEventId,
  onSelectEvent,
  onChatAboutEvent,
  getPrimedEvent,
}: CalendarSectionProps) {
  const t = useAppSelector((s) => s.t);
  const uiAccentId = useAppSelector((s) => s.uiAccentId);
  const calendar = useCalendarWeek();
  useViewEvent(VIEW_EVENTS.VIEW_REFRESH, () => {
    void calendar.refresh();
  }, [calendar.refresh]);
  const [drawerEvent, setDrawerEvent] = useState<LifeOpsCalendarEvent | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefaultDate, setCreateDefaultDate] = useState(new Date());
  const handleCloseEditor = useCallback(() => {
    setDrawerEvent(null);
    onSelectEvent(null);
  }, [onSelectEvent]);
  useEffect(() => {
    if (!selectedEventId) {
      if (drawerEvent !== null) setDrawerEvent(null);
      return;
    }
    if (drawerEvent?.id === selectedEventId) return;
    const event =
      calendar.events.find((event) => event.id === selectedEventId) ??
      getPrimedEvent(selectedEventId);
    if (event) setDrawerEvent(event);
  }, [selectedEventId, calendar.events, drawerEvent, getPrimedEvent]);
  const accentStyle: CSSProperties | undefined =
    uiAccentId === "default"
      ? ({
          "--accent": "var(--eliza-brand-orange, #ff5800)",
          "--accent-rgb": "255, 88, 0",
          "--accent-foreground": "#111111",
          "--accent-hover": "color-mix(in srgb, var(--accent) 88%, white)",
          "--accent-muted": "color-mix(in srgb, var(--accent) 75%, #111111)",
          "--accent-subtle":
            "color-mix(in srgb, var(--accent) 14%, transparent)",
          "--ring": "var(--accent)",
          "--border-hover": "var(--accent)",
          "--primary": "var(--accent)",
        } as CSSProperties)
      : undefined;
  return (
    <>
      <CalendarWorkspace
        calendar={calendar}
        selectedEventId={selectedEventId}
        t={t}
        accentStyle={accentStyle}
        onOpenEvent={(event) => {
          onSelectEvent(event.id);
          setDrawerEvent(event);
        }}
        onCreateEvent={(date) => {
          setCreateDefaultDate(date);
          setCreateOpen(true);
        }}
      />
      <EventEditorDrawer
        open={drawerEvent !== null}
        mode="edit"
        event={drawerEvent}
        onChat={onChatAboutEvent}
        onClose={handleCloseEditor}
        onSaved={(event) => {
          void calendar.refresh();
          setDrawerEvent(event);
        }}
        onDeleted={() => {
          void calendar.refresh();
          setDrawerEvent(null);
          onSelectEvent(null);
        }}
      />
      <EventEditorDrawer
        open={createOpen}
        mode="create"
        event={null}
        createDefaults={{ date: createDefaultDate, side: "owner" }}
        onClose={() => setCreateOpen(false)}
        onCreated={(event) => {
          void calendar.refresh();
          setCreateOpen(false);
          onSelectEvent(event.id);
        }}
      />
    </>
  );
}
