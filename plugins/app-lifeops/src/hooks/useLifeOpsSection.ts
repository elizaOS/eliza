import { useCallback, useEffect, useState } from "react";
import {
  buildLifeOpsHash,
  LIFEOPS_ROUTE_SECTIONS,
  type LifeOpsRouteSection,
  parseLifeOpsRoute,
} from "../lifeops-route.js";

export type LifeOpsSection = LifeOpsRouteSection;

export const LIFEOPS_SECTIONS: LifeOpsSection[] = [...LIFEOPS_ROUTE_SECTIONS];

function isLifeOpsSection(value: unknown): value is LifeOpsSection {
  return (
    typeof value === "string" && (LIFEOPS_SECTIONS as string[]).includes(value)
  );
}

interface ReadHashShape {
  section: LifeOpsSection;
  eventId: string | null;
  messageId: string | null;
}

function readFromHash(initial?: string | null): ReadHashShape {
  const fallbackSection: LifeOpsSection = isLifeOpsSection(initial)
    ? initial
    : "overview";
  if (typeof window === "undefined") {
    return { section: fallbackSection, eventId: null, messageId: null };
  }
  const route = parseLifeOpsRoute(window.location.hash);
  // A lingering `lifeops.event` or `lifeops.message` in the hash implies the
  // corresponding section even if the `section` key was cleared or absent.
  let section: LifeOpsSection | null = route.section;
  if (!section && route.eventId) section = "calendar";
  if (!section && route.messageId) section = "messages";
  return {
    section: section ?? fallbackSection,
    eventId: route.eventId,
    messageId: route.messageId,
  };
}

function writeHash(next: {
  section?: LifeOpsSection | null;
  eventId?: string | null;
  messageId?: string | null;
}): void {
  if (typeof window === "undefined") return;
  try {
    const nextHash = buildLifeOpsHash(window.location.hash, next);
    const url = `${window.location.pathname}${window.location.search}${nextHash}`;
    window.history.replaceState(null, "", url || window.location.href);
  } catch {
    // Best-effort — URL manipulation failures shouldn't break navigation.
  }
}

export interface UseLifeOpsSectionReturn {
  section: LifeOpsSection;
  eventId: string | null;
  messageId: string | null;
  /** Navigate to a section, clearing any detail-view selection. */
  navigate: (next: LifeOpsSection) => void;
  /** Open a specific calendar event as a detail view. */
  openEvent: (eventId: string) => void;
  /** Open a specific inbox message as a detail view. */
  openMessage: (messageId: string) => void;
  /** Close any open detail view, staying on the same section. */
  closeDetail: () => void;
}

export function useLifeOpsSection(
  initial?: string | null,
): UseLifeOpsSectionReturn {
  const [state, setState] = useState<ReadHashShape>(() =>
    readFromHash(initial),
  );

  // Keep the hook in sync with back/forward navigation (including other
  // widgets that write the hash, like the chat-sidebar widget rows).
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onHashChange(): void {
      setState(readFromHash());
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((next: LifeOpsSection) => {
    setState({ section: next, eventId: null, messageId: null });
    writeHash({ section: next, eventId: null, messageId: null });
  }, []);

  const openEvent = useCallback((eventId: string) => {
    setState({ section: "calendar", eventId, messageId: null });
    writeHash({ section: "calendar", eventId, messageId: null });
  }, []);

  const openMessage = useCallback((messageId: string) => {
    setState({ section: "messages", eventId: null, messageId });
    writeHash({ section: "messages", eventId: null, messageId });
  }, []);

  const closeDetail = useCallback(() => {
    setState((prev) => ({ ...prev, eventId: null, messageId: null }));
    writeHash({ eventId: null, messageId: null });
  }, []);

  return {
    section: state.section,
    eventId: state.eventId,
    messageId: state.messageId,
    navigate,
    openEvent,
    openMessage,
    closeDetail,
  };
}
