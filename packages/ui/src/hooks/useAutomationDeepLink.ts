/**
 * useAutomationDeepLink — hash-based deep-link state for the automations
 * feed. Replaces the old `getPathForAutomationSubpage` /
 * `syncAutomationSubpagePath` history-API helpers from AutomationsView.
 *
 * Hash format:
 *   #automations                → list view
 *   #automations/<workflowId>   → open WorkflowEditor for that id
 *   #automations/task/<taskId>  → open TaskEditor for that id
 *
 * Hash is read on mount, written on open/close, and the hashchange event
 * is observed so back/forward navigation works.
 */

import { useCallback, useEffect, useState } from "react";

export type AutomationDeepLink =
  | { kind: "list" }
  | { kind: "workflow"; id: string }
  | { kind: "task"; id: string };

const HASH_PREFIX = "#automations";

export function parseAutomationHash(hash: string): AutomationDeepLink {
  if (!hash.startsWith(HASH_PREFIX)) return { kind: "list" };
  const rest = hash.slice(HASH_PREFIX.length).replace(/^\//, "");
  if (!rest) return { kind: "list" };
  if (rest.startsWith("task/")) {
    const id = rest.slice("task/".length);
    return id ? { kind: "task", id } : { kind: "list" };
  }
  return { kind: "workflow", id: rest };
}

export function formatAutomationHash(link: AutomationDeepLink): string {
  switch (link.kind) {
    case "list":
      return HASH_PREFIX;
    case "workflow":
      return `${HASH_PREFIX}/${link.id}`;
    case "task":
      return `${HASH_PREFIX}/task/${link.id}`;
  }
}

export function useAutomationDeepLink(): {
  link: AutomationDeepLink;
  setLink: (next: AutomationDeepLink) => void;
} {
  const [link, setLinkState] = useState<AutomationDeepLink>(() => {
    if (typeof window === "undefined") return { kind: "list" };
    return parseAutomationHash(window.location.hash);
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onHashChange = () => {
      setLinkState(parseAutomationHash(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const setLink = useCallback((next: AutomationDeepLink) => {
    setLinkState(next);
    if (typeof window === "undefined") return;
    const target = formatAutomationHash(next);
    if (window.location.hash !== target) {
      window.location.hash = target;
    }
  }, []);

  return { link, setLink };
}
