/**
 * Accessible owner controls for calendar feed inclusion and source recovery.
 *
 * The disclosure keeps source administration close to feed truth without
 * turning the calendar into a settings screen. Writes remain server-
 * authoritative, and unavailable reconnect paths are stated rather than
 * guessed.
 */

import type { LifeOpsCalendarSourceHealth } from "@elizaos/shared";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button, Switch } from "@elizaos/ui/components";
import { ChevronDown, RefreshCw, Settings2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useCalendarSources } from "../hooks/useCalendarSources.js";
import {
  type CalendarSourceManagerRow,
  calendarSourceIdentityKey,
  toCalendarSourceManagerModel,
} from "./calendar/source-manager.js";
import { openCalendarConnectorSettings } from "./calendar/source-navigation.js";

export interface CalendarSourceManagerProps {
  sourceHealth: readonly LifeOpsCalendarSourceHealth[];
  onSelectionChanged?: () => void;
  defaultOpen?: boolean;
}

interface SourceToggleProps {
  row: CalendarSourceManagerRow;
  pending: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function SourceToggle({ row, pending, onCheckedChange }: SourceToggleProps) {
  const checked = row.included === true;
  const accessibleLabel = `Include ${row.calendarLabel} (${row.providerLabel}, ${row.accountLabel}) in the combined calendar`;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `toggle-${row.actionId}`,
    role: "toggle",
    label: accessibleLabel,
    group: "calendar-sources",
    status: pending ? "pending" : checked ? "on" : "off",
    getValue: () => checked,
    onActivate: pending ? undefined : () => onCheckedChange(!checked),
  });

  return (
    <Switch
      ref={ref}
      checked={checked}
      disabled={pending}
      onCheckedChange={onCheckedChange}
      aria-label={accessibleLabel}
      {...agentProps}
    />
  );
}

export function CalendarSourceManager({
  sourceHealth,
  onSelectionChanged,
  defaultOpen = false,
}: CalendarSourceManagerProps) {
  const state = useCalendarSources();
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  const model = useMemo(
    () => toCalendarSourceManagerModel(state.calendars, sourceHealth),
    [sourceHealth, state.calendars],
  );
  const includedCount = state.calendars.filter(
    (calendar) => calendar.includeInFeed,
  ).length;
  const { ref: manageRef, agentProps: manageAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "manage-calendar-sources",
      role: "button",
      label: open
        ? "Close calendar source settings"
        : "Manage calendar sources",
      group: "calendar-sources",
      status: open ? "expanded" : "collapsed",
      onActivate: () => setOpen((current) => !current),
    });

  const handleToggle = async (
    actionId: string,
    includeInFeed: boolean,
  ): Promise<void> => {
    const calendar = model.calendarsByActionId.get(actionId);
    if (!calendar) return;
    const outcome = await state.setIncluded(calendar, includeInFeed);
    if (outcome === "updated") onSelectionChanged?.();
  };

  return (
    <section
      className="border-b border-border/12 py-1"
      aria-label="Manage calendar sources"
      data-testid="calendar-source-manager"
    >
      <Button
        ref={manageRef}
        unstyled
        className="flex min-h-9 w-full items-center gap-2 px-1 text-left text-xs font-medium text-muted-strong transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-controls={contentId}
        aria-expanded={open}
        aria-label="Manage calendar sources"
        onClick={() => setOpen((current) => !current)}
        {...manageAgentProps}
      >
        <Settings2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="flex-1">Manage calendar sources</span>
        {state.status === "ready" || state.status === "empty" ? (
          <span className="font-normal text-muted">
            {includedCount} included
          </span>
        ) : null}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden
        />
      </Button>

      {open ? (
        <div id={contentId} className="px-1 pb-3 pt-1">
          <p className="max-w-2xl text-xs leading-5 text-muted">
            New calendars are included automatically. Turn one off to remove it
            from the combined calendar.
          </p>

          {state.status === "loading" ? (
            <p
              className="mt-3 text-xs text-muted"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              Loading calendar sources…
            </p>
          ) : null}

          {state.error ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 text-xs text-danger"
              role="alert"
            >
              <span>{state.error}</span>
              <Button
                unstyled
                className="font-semibold underline underline-offset-2 hover:text-txt"
                onClick={() => void state.refresh()}
              >
                Retry
              </Button>
            </div>
          ) : null}

          {state.refreshError ? (
            <p className="mt-3 text-xs text-warning" role="alert">
              {state.refreshError}
            </p>
          ) : null}

          {state.status === "empty" && model.rows.length === 0 ? (
            <div className="mt-3 text-xs text-muted">
              <p>No calendar sources were found.</p>
              <Button
                unstyled
                className="mt-1 inline-flex items-center gap-1 font-semibold text-muted-strong underline underline-offset-2 hover:text-txt"
                onClick={() => openCalendarConnectorSettings()}
              >
                Open connector settings
              </Button>
            </div>
          ) : null}

          {model.rows.length > 0 ? (
            <ul className="mt-3 divide-y divide-border/12 border-y border-border/12">
              {model.rows.map((row) => {
                const calendar = model.calendarsByActionId.get(row.actionId);
                const identityKey = calendar
                  ? calendarSourceIdentityKey(calendar)
                  : null;
                const pending = identityKey
                  ? state.pendingKeys.has(identityKey)
                  : false;
                const mutationError = identityKey
                  ? state.mutationErrors[identityKey]
                  : null;
                return (
                  <li
                    key={row.actionId}
                    className="py-3"
                    data-testid={`calendar-source-row-${row.actionId}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="truncate text-sm font-semibold text-txt">
                            {row.calendarLabel}
                          </span>
                          {row.primary &&
                          row.calendarLabel.trim().toLowerCase() !==
                            "primary" ? (
                            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                              Primary
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted">
                          {row.providerLabel} · {row.accountLabel}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-muted">
                          {row.accessLabel} · {row.visibilityLabel} ·{" "}
                          <span
                            className={
                              row.tone === "danger"
                                ? "text-danger"
                                : row.tone === "warning"
                                  ? "text-warning"
                                  : row.tone === "success"
                                    ? "text-success"
                                    : undefined
                            }
                          >
                            {row.statusLabel}
                          </span>{" "}
                          · {row.freshnessLabel}
                        </p>
                      </div>

                      {row.toggleAvailable ? (
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <SourceToggle
                            row={row}
                            pending={pending}
                            onCheckedChange={(checked) =>
                              void handleToggle(row.actionId, checked)
                            }
                          />
                          <span
                            className="text-[11px] text-muted"
                            role={pending ? "status" : undefined}
                            aria-live="polite"
                          >
                            {pending
                              ? row.included
                                ? "Excluding…"
                                : "Including…"
                              : row.included
                                ? "Included"
                                : "Excluded"}
                          </span>
                        </div>
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted">
                          Inclusion unavailable
                        </span>
                      )}
                    </div>

                    {mutationError ? (
                      <p className="mt-2 text-xs text-danger" role="alert">
                        {mutationError}
                      </p>
                    ) : null}

                    {row.reconnectConnectorId ? (
                      <Button
                        unstyled
                        className="mt-2 text-xs font-semibold text-muted-strong underline underline-offset-2 hover:text-txt"
                        onClick={() =>
                          openCalendarConnectorSettings(
                            row.reconnectConnectorId ?? undefined,
                          )
                        }
                      >
                        Reconnect Google Calendar
                      </Button>
                    ) : row.reconnectUnavailable ? (
                      <p className="mt-2 text-xs text-muted">
                        Reconnect unavailable here.
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {model.rows.length > 0 ? (
            <Button
              unstyled
              className="mt-2 inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-muted transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              disabled={state.refreshing}
              onClick={() => void state.refresh()}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  state.refreshing ? "animate-spin" : ""
                }`}
                aria-hidden
              />
              {state.refreshing ? "Refreshing sources…" : "Refresh sources"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
