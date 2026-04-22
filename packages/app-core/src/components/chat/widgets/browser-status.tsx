/**
 * Compact browser-workspace widget for the chat-sidebar.
 *
 * Polls the workspace snapshot and surfaces:
 *   - bridge mode (web / desktop / cloud)
 *   - open tab count
 *   - the title of the visible (or first) tab
 * Click the title to jump to /browser.
 */

import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import {
  type BrowserWorkspaceSnapshot,
  type BrowserWorkspaceTab,
  client,
} from "../../../api";
import { useApp } from "../../../state";
import {
  type ChatSidebarWidgetDefinition,
  type ChatSidebarWidgetProps,
} from "./types";
import { EmptyWidgetState, WidgetSection } from "./shared";

const POLL_INTERVAL_MS = 4_000;

function modeLabel(mode: BrowserWorkspaceSnapshot["mode"]): string {
  if (mode === "desktop") return "Desktop";
  if (mode === "cloud") return "Cloud";
  return "Web";
}

function pickPrimaryTab(
  tabs: readonly BrowserWorkspaceTab[],
): BrowserWorkspaceTab | null {
  if (tabs.length === 0) return null;
  return tabs.find((tab) => tab.visible) ?? tabs[0];
}

export function BrowserStatusSidebarWidget(_props: ChatSidebarWidgetProps) {
  const { setTab } = useApp();
  const [snapshot, setSnapshot] = useState<BrowserWorkspaceSnapshot | null>(
    null,
  );
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const next = await client.getBrowserWorkspace();
        if (cancelled) return;
        setSnapshot(next);
        setErrored(false);
      } catch {
        if (cancelled) return;
        setErrored(true);
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
  const primary = pickPrimaryTab(tabs);
  const mode = snapshot ? modeLabel(snapshot.mode) : "—";

  return (
    <WidgetSection
      title="Browser"
      icon={<Globe className="h-3.5 w-3.5" />}
      testId="chat-widget-browser-status"
      onTitleClick={() => setTab("browser")}
    >
      {snapshot === null ? (
        <EmptyWidgetState
          icon={<Globe className="h-5 w-5" />}
          title={errored ? "Browser unavailable" : "Loading browser…"}
        />
      ) : (
        <div className="flex flex-col gap-1 px-1 pt-0.5">
          <div className="flex items-center justify-between text-3xs">
            <span className="text-muted">Mode</span>
            <span className="text-txt">{mode}</span>
          </div>
          <div className="flex items-center justify-between text-3xs">
            <span className="text-muted">Tabs</span>
            <span className="text-txt">{tabs.length}</span>
          </div>
          {primary ? (
            <div className="truncate text-3xs text-txt" title={primary.url}>
              {primary.title?.trim() || primary.url}
            </div>
          ) : null}
        </div>
      )}
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
