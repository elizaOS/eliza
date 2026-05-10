/**
 * Compact browser-workspace widget for the chat-sidebar.
 *
 * Polls the workspace snapshot and renders a compact list of open tabs with
 * a status indicator per tab (visible / background). Returns null when no
 * tabs are open — the widget keeps the right rail quiet until the user
 * actually has browser state.
 *
 * Title-click opens /browser. Tab-click focuses that tab via the backend.
 */

import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type BrowserWorkspaceSnapshot,
  type BrowserWorkspaceTab,
  client,
} from "../../../api";
import { useApp } from "../../../state";
import { WidgetSection } from "./shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";

const POLL_INTERVAL_MS = 4_000;
const MAX_TAB_ROWS = 8;

function tabLabel(tab: BrowserWorkspaceTab): string {
  const title = tab.title?.trim();
  if (title) return title;
  const url = tab.url?.trim();
  if (!url) return "New tab";
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

interface TabStatusStyle {
  label: string;
  dotClass: string;
  textClass: string;
}

function tabStatus(tab: BrowserWorkspaceTab): TabStatusStyle {
  if (tab.visible) {
    return {
      label: "Active",
      dotClass: "bg-accent",
      textClass: "text-txt",
    };
  }
  return {
    label: "Background",
    dotClass: "bg-muted/50",
    textClass: "text-muted",
  };
}

export function BrowserStatusSidebarWidget(_props: ChatSidebarWidgetProps) {
  const { setTab } = useApp();
  const [snapshot, setSnapshot] = useState<BrowserWorkspaceSnapshot | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const next = await client.getBrowserWorkspace();
        if (cancelled) return;
        setSnapshot(next);
      } catch {
        // Transient errors — keep the last snapshot.
      } finally {
        if (!cancelled) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const tabs = snapshot?.tabs ?? [];
  if (tabs.length === 0) {
    // Hide the widget entirely until the user has open tabs — the sidebar
    // stays quiet when the browser surface has nothing to say.
    return null;
  }

  const rows = tabs.slice(0, MAX_TAB_ROWS);

  function handleTabClick(tab: BrowserWorkspaceTab) {
    // Best-effort: bring the tab forward in the workspace. Not every backend
    // implements this (web mode falls through silently) — we always also
    // navigate to /browser so the user lands on the workspace view.
    void (async () => {
      try {
        await client.showBrowserWorkspaceTab?.(tab.id);
      } catch {
        // Ignore — navigation still happens.
      }
    })();
    setTab("browser");
  }

  return (
    <WidgetSection
      title="Browser"
      icon={<Globe className="h-3.5 w-3.5" />}
      testId="chat-widget-browser-status"
      onTitleClick={() => setTab("browser")}
    >
      <div className="flex flex-col gap-0.5 pt-0.5">
        {rows.map((tab) => {
          const label = tabLabel(tab);
          const status = tabStatus(tab);
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleTabClick(tab)}
              title={tab.url ?? label}
              data-testid={`chat-widget-browser-tab-${tab.id}`}
              className="flex items-center gap-2 rounded-[var(--radius-sm)] px-0.5 py-0.5 text-left transition-colors hover:bg-bg-hover/40"
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dotClass}`}
                aria-hidden
              />
              <span
                className={`min-w-0 flex-1 truncate text-3xs ${status.textClass}`}
              >
                {label}
              </span>
              <span className="shrink-0 text-3xs uppercase tracking-wider text-muted/70">
                {status.label}
              </span>
            </button>
          );
        })}
      </div>
    </WidgetSection>
  );
}

export const BROWSER_STATUS_WIDGET: ChatSidebarWidgetDefinition = {
  id: "browser.status",
  pluginId: "browser-workspace",
  order: 75,
  defaultEnabled: true,
  Component: BrowserStatusSidebarWidget,
};
