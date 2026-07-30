/**
 * Accessible owner controls for calendar feed inclusion and source recovery.
 *
 * The disclosure keeps source administration close to feed truth without
 * turning the calendar into a settings screen. Writes remain server-
 * authoritative, and unavailable reconnect paths are stated rather than
 * guessed. ICS/webcal subscriptions are managed here too: this disclosure is
 * the client trigger for the subscription create/delete routes, so the feed
 * never gains a source the owner cannot also remove from the same surface.
 */

import type {
  LifeOpsCalendarSourceHealth,
  LifeOpsIcsCalendarSource,
} from "@elizaos/shared";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client } from "@elizaos/ui/api";
import { Button, ConfirmDialog, Input, Switch } from "@elizaos/ui/components";
import { useAppSelector } from "@elizaos/ui/state";
import { ChevronDown, RefreshCw, Settings2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import "../api/client-calendar.js";
import type { CalendarClientMethods } from "../api/client-calendar.js";
import { useCalendarSources } from "../hooks/useCalendarSources.js";
import {
  type CalendarSourceManagerRow,
  calendarSourceIdentityKey,
  toCalendarSourceManagerModel,
} from "./calendar/source-manager.js";
import { openCalendarConnectorSettings } from "./calendar/source-navigation.js";

const calendarClient = client as typeof client & CalendarClientMethods;

export interface CalendarSourceManagerProps {
  sourceHealth: readonly LifeOpsCalendarSourceHealth[];
  onSelectionChanged?: () => void;
  defaultOpen?: boolean;
}

interface SourceToggleProps {
  row: CalendarSourceManagerRow;
  label: string;
  pending: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function SourceToggle({
  row,
  label,
  pending,
  onCheckedChange,
}: SourceToggleProps) {
  const checked = row.included === true;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `toggle-${row.actionId}`,
    role: "toggle",
    label,
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
      aria-label={label}
      {...agentProps}
    />
  );
}

type IcsSectionStatus = "idle" | "loading" | "ready" | "error";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message.trim()
    : fallback;
}

export function CalendarSourceManager({
  sourceHealth,
  onSelectionChanged,
  defaultOpen = false,
}: CalendarSourceManagerProps) {
  const t = useAppSelector((s) => s.t);
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

  const [icsSources, setIcsSources] = useState<LifeOpsIcsCalendarSource[]>([]);
  const [icsStatus, setIcsStatus] = useState<IcsSectionStatus>("idle");
  const [icsError, setIcsError] = useState<string | null>(null);
  const [icsName, setIcsName] = useState("");
  const [icsUrl, setIcsUrl] = useState("");
  const [icsSubmitting, setIcsSubmitting] = useState(false);
  const [icsMutationError, setIcsMutationError] = useState<string | null>(null);
  const [icsRemoveTarget, setIcsRemoveTarget] =
    useState<LifeOpsIcsCalendarSource | null>(null);
  const [icsRemovingId, setIcsRemovingId] = useState<string | null>(null);
  // Generation counter so a slow list response can never clobber the state a
  // later load or mutation-triggered reload already produced.
  const icsGenerationRef = useRef(0);

  const loadIcsSources = useCallback(async () => {
    const generation = ++icsGenerationRef.current;
    setIcsStatus("loading");
    setIcsError(null);
    try {
      const response = await calendarClient.getLifeOpsIcsCalendarSources();
      if (icsGenerationRef.current !== generation) return;
      setIcsSources(response.sources);
      setIcsStatus("ready");
    } catch (cause) {
      // error-policy:J4 A failed subscription list renders as a designed error
      // state with retry; it must never render as an empty healthy list.
      if (icsGenerationRef.current !== generation) return;
      setIcsError(
        errorMessage(
          cause,
          t("calendarSources.icsListFailed", {
            defaultValue: "Calendar subscriptions could not load.",
          }),
        ),
      );
      setIcsStatus("error");
    }
  }, [t]);

  useEffect(() => {
    if (open && icsStatus === "idle") void loadIcsSources();
  }, [open, icsStatus, loadIcsSources]);

  const { ref: manageRef, agentProps: manageAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "manage-calendar-sources",
      role: "button",
      label: open
        ? t("calendarSources.closeManage", {
            defaultValue: "Close calendar source settings",
          })
        : t("calendarSources.manage", {
            defaultValue: "Manage calendar sources",
          }),
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

  const handleIcsSubscribe = async (): Promise<void> => {
    const name = icsName.trim();
    const url = icsUrl.trim();
    if (!name || !url || icsSubmitting) return;
    setIcsSubmitting(true);
    setIcsMutationError(null);
    try {
      const created = await calendarClient.createLifeOpsIcsCalendarSource({
        name,
        url,
      });
      setIcsName("");
      setIcsUrl("");
      try {
        await calendarClient.syncLifeOpsIcsCalendarSource(created.source.id);
      } catch {
        // error-policy:J5 The subscription exists and its sync failure is
        // persisted server-side; the reloaded row below renders that error
        // status, which is where this rejection is observed.
      }
      await loadIcsSources();
      onSelectionChanged?.();
    } catch (cause) {
      // error-policy:J4 A failed subscribe keeps the entered name/URL visible
      // alongside the provider error so the owner can correct and retry.
      setIcsMutationError(
        errorMessage(
          cause,
          t("calendarSources.icsSubscribeFailed", {
            defaultValue: "Could not add the calendar subscription.",
          }),
        ),
      );
    } finally {
      setIcsSubmitting(false);
    }
  };

  const handleIcsRemove = async (): Promise<void> => {
    const target = icsRemoveTarget;
    if (!target) return;
    setIcsRemoveTarget(null);
    setIcsRemovingId(target.id);
    setIcsMutationError(null);
    try {
      await calendarClient.deleteLifeOpsIcsCalendarSource(target.id);
      await loadIcsSources();
      onSelectionChanged?.();
    } catch (cause) {
      // error-policy:J4 A failed removal keeps the subscription listed with a
      // visible error instead of pretending it disappeared.
      setIcsMutationError(
        errorMessage(
          cause,
          t("calendarSources.icsRemoveFailed", {
            defaultValue: "Could not remove the calendar subscription.",
          }),
        ),
      );
    } finally {
      setIcsRemovingId(null);
    }
  };

  const icsStatusLine = (source: LifeOpsIcsCalendarSource): string => {
    switch (source.syncStatus) {
      case "error":
        return (
          source.error?.message ??
          t("calendarSources.icsSyncFailed", { defaultValue: "Sync failed" })
        );
      case "never":
        return t("calendarSources.icsNeverSynced", {
          defaultValue: "Not synced yet",
        });
      case "partial":
        return t("calendarSources.icsPartialSync", {
          defaultValue: "Partially synced",
        });
      case "fresh":
        return t("calendarSources.icsSynced", { defaultValue: "Synced" });
    }
  };

  const icsSubscribeReady =
    icsName.trim().length > 0 && icsUrl.trim().length > 0 && !icsSubmitting;

  return (
    <section
      className="border-b border-border/12 py-1"
      aria-label={t("calendarSources.manage", {
        defaultValue: "Manage calendar sources",
      })}
      data-testid="calendar-source-manager"
    >
      <Button
        ref={manageRef}
        unstyled
        className="flex min-h-9 w-full items-center gap-2 px-1 text-left text-xs font-medium text-muted-strong transition-colors hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-controls={contentId}
        aria-expanded={open}
        aria-label={t("calendarSources.manage", {
          defaultValue: "Manage calendar sources",
        })}
        onClick={() => setOpen((current) => !current)}
        {...manageAgentProps}
      >
        <Settings2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="flex-1">
          {t("calendarSources.manage", {
            defaultValue: "Manage calendar sources",
          })}
        </span>
        {state.status === "ready" || state.status === "empty" ? (
          <span className="font-normal text-muted">
            {t("calendarSources.includedCount", {
              defaultValue: "{{count}} included",
              count: includedCount,
            })}
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
            {t("calendarSources.autoIncludeHint", {
              defaultValue:
                "New calendars are included automatically. Turn one off to remove it from the combined calendar.",
            })}
          </p>

          {state.status === "loading" ? (
            <p
              className="mt-3 text-xs text-muted"
              role="status"
              aria-live="polite"
              aria-busy="true"
            >
              {t("calendarSources.loading", {
                defaultValue: "Loading calendar sources…",
              })}
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
                {t("common.retry", { defaultValue: "Retry" })}
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
              <p>
                {t("calendarSources.noneFound", {
                  defaultValue: "No calendar sources were found.",
                })}
              </p>
              <Button
                unstyled
                className="mt-1 inline-flex items-center gap-1 font-semibold text-muted-strong underline underline-offset-2 hover:text-txt"
                onClick={() => openCalendarConnectorSettings()}
              >
                {t("calendarSources.openConnectorSettings", {
                  defaultValue: "Open connector settings",
                })}
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
                              {t("calendarSources.primary", {
                                defaultValue: "Primary",
                              })}
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
                            label={t("calendarSources.includeToggle", {
                              defaultValue:
                                "Include {{calendar}} ({{provider}}, {{account}}) in the combined calendar",
                              calendar: row.calendarLabel,
                              provider: row.providerLabel,
                              account: row.accountLabel,
                            })}
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
                                ? t("calendarSources.excluding", {
                                    defaultValue: "Excluding…",
                                  })
                                : t("calendarSources.including", {
                                    defaultValue: "Including…",
                                  })
                              : row.included
                                ? t("calendarSources.included", {
                                    defaultValue: "Included",
                                  })
                                : t("calendarSources.excluded", {
                                    defaultValue: "Excluded",
                                  })}
                          </span>
                        </div>
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted">
                          {t("calendarSources.inclusionUnavailable", {
                            defaultValue: "Inclusion unavailable",
                          })}
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
                        {t("calendarSources.reconnectGoogle", {
                          defaultValue: "Reconnect Google Calendar",
                        })}
                      </Button>
                    ) : row.reconnectUnavailable ? (
                      <p className="mt-2 text-xs text-muted">
                        {t("calendarSources.reconnectUnavailable", {
                          defaultValue: "Reconnect unavailable here.",
                        })}
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
              {state.refreshing
                ? t("calendarSources.refreshingSources", {
                    defaultValue: "Refreshing sources…",
                  })
                : t("calendarSources.refreshSources", {
                    defaultValue: "Refresh sources",
                  })}
            </Button>
          ) : null}

          <div
            className="mt-4 border-t border-border/12 pt-3"
            data-testid="calendar-ics-sources"
          >
            <h3 className="text-xs font-medium text-muted-strong">
              {t("calendarSources.icsHeading", {
                defaultValue: "Calendar subscriptions (ICS)",
              })}
            </h3>

            {icsStatus === "loading" ? (
              <p
                className="mt-2 text-xs text-muted"
                role="status"
                aria-live="polite"
                aria-busy="true"
              >
                {t("calendarSources.icsLoading", {
                  defaultValue: "Loading subscriptions…",
                })}
              </p>
            ) : null}

            {icsStatus === "error" && icsError ? (
              <div
                className="mt-2 flex flex-wrap items-center gap-2 text-xs text-danger"
                role="alert"
              >
                <span>{icsError}</span>
                <Button
                  unstyled
                  className="font-semibold underline underline-offset-2 hover:text-txt"
                  onClick={() => void loadIcsSources()}
                >
                  {t("common.retry", { defaultValue: "Retry" })}
                </Button>
              </div>
            ) : null}

            {icsStatus === "ready" && icsSources.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                {t("calendarSources.icsEmpty", {
                  defaultValue: "No calendar subscriptions yet.",
                })}
              </p>
            ) : null}

            {icsSources.length > 0 ? (
              <ul className="mt-2 divide-y divide-border/12 border-y border-border/12">
                {icsSources.map((source) => (
                  <li
                    key={source.id}
                    className="flex items-start gap-3 py-2.5"
                    data-testid={`calendar-ics-source-${source.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-txt">
                        {source.name}
                      </span>
                      <p className="mt-0.5 truncate text-xs text-muted">
                        {source.origin} ·{" "}
                        <span
                          className={
                            source.syncStatus === "error"
                              ? "text-danger"
                              : source.syncStatus === "partial"
                                ? "text-warning"
                                : undefined
                          }
                        >
                          {icsStatusLine(source)}
                        </span>
                      </p>
                    </div>
                    <Button
                      unstyled
                      className="shrink-0 text-xs font-semibold text-muted-strong underline underline-offset-2 hover:text-danger"
                      disabled={icsRemovingId === source.id}
                      aria-label={t("calendarSources.icsRemoveAria", {
                        defaultValue: "Remove subscription {{name}}",
                        name: source.name,
                      })}
                      onClick={() => setIcsRemoveTarget(source)}
                    >
                      {icsRemovingId === source.id
                        ? t("calendarSources.icsRemoving", {
                            defaultValue: "Removing…",
                          })
                        : t("common.remove", { defaultValue: "Remove" })}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}

            {icsMutationError ? (
              <p className="mt-2 text-xs text-danger" role="alert">
                {icsMutationError}
              </p>
            ) : null}

            <form
              className="mt-3 flex flex-wrap items-center gap-2"
              onSubmit={(submitEvent) => {
                submitEvent.preventDefault();
                void handleIcsSubscribe();
              }}
            >
              <Input
                value={icsName}
                onChange={(changeEvent) => setIcsName(changeEvent.target.value)}
                placeholder={t("calendarSources.icsNamePlaceholder", {
                  defaultValue: "Subscription name",
                })}
                aria-label={t("calendarSources.icsNameAria", {
                  defaultValue: "Subscription name",
                })}
                disabled={icsSubmitting}
                className="h-8 w-40 text-xs"
              />
              <Input
                value={icsUrl}
                onChange={(changeEvent) => setIcsUrl(changeEvent.target.value)}
                placeholder={t("calendarSources.icsUrlPlaceholder", {
                  defaultValue: "https:// or webcal:// feed URL",
                })}
                aria-label={t("calendarSources.icsUrlAria", {
                  defaultValue: "Subscription URL",
                })}
                disabled={icsSubmitting}
                className="h-8 min-w-0 flex-1 text-xs"
              />
              <Button
                type="submit"
                size="sm"
                className="h-8 px-2.5 text-xs font-semibold"
                disabled={!icsSubscribeReady}
              >
                {icsSubmitting
                  ? t("calendarSources.icsSubscribing", {
                      defaultValue: "Subscribing…",
                    })
                  : t("calendarSources.icsSubscribe", {
                      defaultValue: "Subscribe",
                    })}
              </Button>
            </form>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={icsRemoveTarget !== null}
        title={t("calendarSources.icsRemoveTitle", {
          defaultValue: "Remove subscription?",
        })}
        message={t("calendarSources.icsRemoveMessage", {
          defaultValue:
            "Events from “{{name}}” will disappear from the combined calendar. The feed itself is not affected.",
          name: icsRemoveTarget?.name ?? "",
        })}
        confirmLabel={t("common.remove", { defaultValue: "Remove" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void handleIcsRemove()}
        onCancel={() => setIcsRemoveTarget(null)}
      />
    </section>
  );
}
