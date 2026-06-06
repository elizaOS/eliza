/**
 * LifeOpsCalendarSection — thin LifeOps shell adapter around the calendar
 * view that lives in `@elizaos/plugin-calendar`.
 *
 * The calendar UI (`CalendarSection`) is shell-agnostic: it takes selection,
 * chat-launch, and primed-event lookup as injected props. This wrapper wires
 * the LifeOps dashboard's own selection context, chat launcher, and event
 * prime cache into those props so the rendering surface is unchanged.
 */

import { CalendarSection } from "@elizaos/plugin-calendar/ui";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { useCallback } from "react";
import { getPrimedLifeOpsEvent } from "../lifeops-route.js";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.helpers.js";
import {
  type LifeOpsSelection,
  useLifeOpsSelection,
} from "./LifeOpsSelectionContext.helpers.js";

export interface LifeOpsCalendarSectionProps {
  selection?: LifeOpsSelection;
  onSelect?: (args: Partial<LifeOpsSelection> | null) => void;
}

function getPrimedEvent(id: string): LifeOpsCalendarEvent | null {
  return getPrimedLifeOpsEvent<LifeOpsCalendarEvent>(id);
}

export function LifeOpsCalendarSection(
  props: LifeOpsCalendarSectionProps = {},
) {
  const ctx = useLifeOpsSelection();
  const selection = props.selection ?? ctx.selection;
  const onSelect = props.onSelect ?? ctx.select;
  const { chatAboutEvent } = useLifeOpsChatLauncher();

  const handleSelectEvent = useCallback(
    (eventId: string | null) => {
      onSelect({ eventId });
    },
    [onSelect],
  );

  return (
    <CalendarSection
      selectedEventId={selection.eventId ?? null}
      onSelectEvent={handleSelectEvent}
      onChatAboutEvent={chatAboutEvent}
      getPrimedEvent={getPrimedEvent}
    />
  );
}
