/**
 * OWNER-only admin surface for account-pool consumer keys (#16478): list,
 * create, rotate, enable/disable, and quota editing against the agent's
 * `/api/accounts/consumer-keys` boundary. Loading, designed-empty, and error
 * are three distinct states; destructive actions (rotate, disable) require an
 * inline confirm. Plaintext keys exist only in the one-time banner rendered
 * from a create/rotate response — they are never stored, logged, or placed in
 * URLs, and dismissing the banner discards the only copy.
 */

import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AgentButton } from "../../agent-surface/components";
import { client } from "../../api";
import type {
  ConsumerKeyCreated,
  ConsumerKeyPatch,
  ConsumerKeySummary,
} from "../../api/client-agent-consumer-keys";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state/app-store";
import { OwnerOnlyNotice, RoleGate } from "../RoleGate";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

export interface ConsumerKeyPanelApi {
  listConsumerKeys(): Promise<ConsumerKeySummary[]>;
  createConsumerKey(body: ConsumerKeyPatch): Promise<ConsumerKeyCreated>;
  updateConsumerKey(
    id: string,
    body: ConsumerKeyPatch,
  ): Promise<ConsumerKeySummary>;
  rotateConsumerKey(id: string): Promise<ConsumerKeyCreated>;
}

interface OneTimeKey {
  key: string;
  label: string;
  kind: "created" | "rotated";
}

type ConfirmTarget =
  | { id: string; action: "rotate" }
  | { id: string; action: "disable" };

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One-time plaintext banner: copy + explicit dismiss, nothing persisted. */
function OneTimeKeyBanner({
  oneTime,
  onDismiss,
}: {
  oneTime: OneTimeKey;
  onDismiss: () => void;
}) {
  const t = useAppSelector((s) => s.t);
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-warning/60 bg-warning/10 p-3"
      data-testid="one-time-key"
    >
      <div className="flex items-center gap-2 text-xs font-medium">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {t("consumerKeys.oneTimeWarning", {
            defaultValue:
              "Copy this key now — it is shown only once and cannot be recovered.",
          })}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 overflow-x-auto rounded-sm bg-card/70 px-2 py-1 font-mono text-xs"
          data-testid="one-time-key-value"
        >
          {oneTime.key}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(oneTime.key);
            setCopied(true);
          }}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" aria-hidden />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden />
          )}
          {copied
            ? t("consumerKeys.copied", { defaultValue: "Copied" })
            : t("consumerKeys.copy", { defaultValue: "Copy" })}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <X className="h-3.5 w-3.5" aria-hidden />
          {t("consumerKeys.dismiss", { defaultValue: "Dismiss" })}
        </Button>
      </div>
      <p className="text-[11px] text-muted">
        {oneTime.kind === "rotated"
          ? t("consumerKeys.rotatedFor", {
              defaultValue:
                "Rotated key for {{label}}. The old key no longer works.",
              label: oneTime.label,
            })
          : t("consumerKeys.createdFor", {
              defaultValue: "New key for {{label}}.",
              label: oneTime.label,
            })}
      </p>
    </div>
  );
}

/**
 * Panel body — assumes the OWNER gate already passed. Exported separately so
 * tests can drive every state without stubbing role resolution.
 */
export function ConsumerKeyPanelBody({
  api = client,
}: {
  api?: ConsumerKeyPanelApi;
}) {
  const t = useAppSelector((s) => s.t);
  const uiLanguage = useAppSelector((s) => s.uiLanguage);
  const [keys, setKeys] = useState<ConsumerKeySummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [oneTime, setOneTime] = useState<OneTimeKey | null>(null);
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createLabel, setCreateLabel] = useState("");
  const [createQuota, setCreateQuota] = useState("");
  const [quotaEdit, setQuotaEdit] = useState<{
    id: string;
    value: string;
  } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await api.listConsumerKeys());
    } catch (loadError) {
      // error-policy:J4 the list read failing renders the explicit error+retry
      // state; an empty-looking healthy panel would misreport the store.
      setError(errorText(loadError));
      setKeys(null);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const withBusy = useCallback(
    async (id: string, task: () => Promise<void>) => {
      setBusy((prev) => new Set(prev).add(id));
      setActionError(null);
      try {
        await task();
      } catch (taskError) {
        // error-policy:J4 mutation failures surface in the panel's action
        // notice; the row keeps its authoritative server state.
        setActionError(errorText(taskError));
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  const replaceKey = useCallback((next: ConsumerKeySummary) => {
    setKeys((prev) =>
      prev ? prev.map((entry) => (entry.id === next.id ? next : entry)) : prev,
    );
  }, []);

  const submitCreate = useCallback(async () => {
    const quotaNumber = createQuota.trim() ? Number(createQuota.trim()) : null;
    if (
      quotaNumber !== null &&
      (!Number.isSafeInteger(quotaNumber) || quotaNumber <= 0)
    ) {
      setActionError(
        t("consumerKeys.invalidQuota", {
          defaultValue: "Daily token quota must be a positive integer.",
        }),
      );
      return;
    }
    await withBusy("create", async () => {
      const created = await api.createConsumerKey({
        label: createLabel.trim() || "consumer",
        dailyTokenQuota: quotaNumber,
      });
      setOneTime({
        key: created.key,
        label: created.consumer.label,
        kind: "created",
      });
      setCreateOpen(false);
      setCreateLabel("");
      setCreateQuota("");
      setKeys((prev) =>
        prev ? [...prev, created.consumer] : [created.consumer],
      );
    });
  }, [api, createLabel, createQuota, t, withBusy]);

  if (loading) {
    return (
      <div className="flex flex-col gap-2" data-testid="consumer-keys-loading">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div
        className="flex flex-col items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3"
        data-testid="consumer-keys-error"
      >
        <div className="flex items-center gap-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t("consumerKeys.loadFailed", {
              defaultValue: "Failed to load consumer keys: {{error}}",
              error,
            })}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          {t("consumerKeys.retry", { defaultValue: "Retry" })}
        </Button>
      </div>
    );
  }

  const list = keys ?? [];

  return (
    <div className="flex flex-col gap-3" data-testid="consumer-keys-panel">
      {oneTime ? (
        <OneTimeKeyBanner
          oneTime={oneTime}
          onDismiss={() => setOneTime(null)}
        />
      ) : null}
      {actionError ? (
        <div
          className="flex items-center gap-2 rounded-sm border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-xs"
          data-testid="consumer-keys-action-error"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{actionError}</span>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-medium">
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          <span>
            {t("consumerKeys.title", { defaultValue: "Consumer keys" })}
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy.has("create")}
          onClick={() => setCreateOpen((open) => !open)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t("consumerKeys.create", { defaultValue: "Create key" })}
        </Button>
      </div>

      {createOpen ? (
        <div
          className="flex flex-wrap items-end gap-2 rounded-lg border border-border/50 bg-card/40 p-3"
          data-testid="consumer-keys-create-form"
        >
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            {t("consumerKeys.labelField", { defaultValue: "Label" })}
            <input
              className="h-8 rounded-sm border border-border/60 bg-card px-2 text-xs"
              value={createLabel}
              onChange={(event) => setCreateLabel(event.target.value)}
              placeholder="protocol-proxy"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            {t("consumerKeys.quotaField", {
              defaultValue: "Daily token quota (blank = unlimited)",
            })}
            <input
              className="h-8 w-44 rounded-sm border border-border/60 bg-card px-2 text-xs"
              value={createQuota}
              onChange={(event) => setCreateQuota(event.target.value)}
              inputMode="numeric"
              placeholder="1000000"
            />
          </label>
          <Button
            size="sm"
            disabled={busy.has("create")}
            onClick={() => void submitCreate()}
          >
            {t("consumerKeys.confirmCreate", { defaultValue: "Create" })}
          </Button>
        </div>
      ) : null}

      {list.length === 0 ? (
        <p
          className="rounded-lg border border-border/40 bg-card/30 px-3 py-4 text-xs text-muted"
          data-testid="consumer-keys-empty"
        >
          {t("consumerKeys.empty", {
            defaultValue:
              "No consumer keys yet. Create one to let an external proxy meter usage through the account pool.",
          })}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((entry) => {
            const rowBusy = busy.has(entry.id);
            const rowConfirm = confirm?.id === entry.id ? confirm : null;
            const editing = quotaEdit?.id === entry.id ? quotaEdit : null;
            return (
              <li
                key={entry.id}
                className="flex flex-col gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-2.5"
                data-testid={`consumer-key-${entry.id}`}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs font-medium">{entry.label}</span>
                  <code className="font-mono text-[11px] text-muted">
                    {entry.keyPrefix}…
                  </code>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium",
                      entry.enabled
                        ? "bg-success/15 text-success"
                        : "bg-muted/20 text-muted",
                    )}
                  >
                    {entry.enabled
                      ? t("consumerKeys.enabled", { defaultValue: "Enabled" })
                      : t("consumerKeys.disabled", {
                          defaultValue: "Disabled",
                        })}
                  </span>
                  <span className="text-[11px] text-muted">
                    {entry.dailyTokenQuota === null
                      ? t("consumerKeys.quotaUnlimited", {
                          defaultValue: "No quota",
                        })
                      : t("consumerKeys.quotaPerDay", {
                          defaultValue: "{{quota}} tokens/day",
                          quota:
                            entry.dailyTokenQuota.toLocaleString(uiLanguage),
                        })}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                  <span>
                    {t("consumerKeys.created", {
                      defaultValue: "Created {{when}}",
                      when: formatTimestamp(entry.createdAt),
                    })}
                  </span>
                  <span>
                    {t("consumerKeys.lastUsed", {
                      defaultValue: "Last used {{when}}",
                      when: formatTimestamp(entry.lastUsedAt),
                    })}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {rowConfirm ? (
                    <>
                      <span className="text-[11px]">
                        {rowConfirm.action === "rotate"
                          ? t("consumerKeys.confirmRotate", {
                              defaultValue:
                                "Rotate this key? The current key stops working immediately.",
                            })
                          : t("consumerKeys.confirmDisable", {
                              defaultValue:
                                "Disable this key? Its callers will be rejected.",
                            })}
                      </span>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={rowBusy}
                        onClick={() => {
                          setConfirm(null);
                          void withBusy(entry.id, async () => {
                            if (rowConfirm.action === "rotate") {
                              const rotated = await api.rotateConsumerKey(
                                entry.id,
                              );
                              replaceKey(rotated.consumer);
                              setOneTime({
                                key: rotated.key,
                                label: rotated.consumer.label,
                                kind: "rotated",
                              });
                            } else {
                              replaceKey(
                                await api.updateConsumerKey(entry.id, {
                                  enabled: false,
                                }),
                              );
                            }
                          });
                        }}
                      >
                        {t("consumerKeys.confirm", { defaultValue: "Confirm" })}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirm(null)}
                      >
                        {t("consumerKeys.cancel", { defaultValue: "Cancel" })}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={rowBusy}
                        onClick={() =>
                          setConfirm({ id: entry.id, action: "rotate" })
                        }
                      >
                        <RotateCw className="h-3.5 w-3.5" aria-hidden />
                        {t("consumerKeys.rotate", { defaultValue: "Rotate" })}
                      </Button>
                      {entry.enabled ? (
                        <AgentButton
                          agentId={`consumer-key-${entry.id}-disable`}
                          agentLabel={`Disable ${entry.label}`}
                          size="sm"
                          variant="ghost"
                          disabled={rowBusy}
                          onClick={() =>
                            setConfirm({ id: entry.id, action: "disable" })
                          }
                        >
                          {t("consumerKeys.disable", {
                            defaultValue: "Disable",
                          })}
                        </AgentButton>
                      ) : (
                        <AgentButton
                          agentId={`consumer-key-${entry.id}-enable`}
                          agentLabel={`Enable ${entry.label}`}
                          size="sm"
                          variant="ghost"
                          disabled={rowBusy}
                          onClick={() =>
                            void withBusy(entry.id, async () => {
                              replaceKey(
                                await api.updateConsumerKey(entry.id, {
                                  enabled: true,
                                }),
                              );
                            })
                          }
                        >
                          {t("consumerKeys.enable", { defaultValue: "Enable" })}
                        </AgentButton>
                      )}
                      {editing ? (
                        <span className="flex items-center gap-1">
                          <input
                            className="h-7 w-32 rounded-sm border border-border/60 bg-card px-2 text-xs"
                            value={editing.value}
                            inputMode="numeric"
                            aria-label={t("consumerKeys.quotaField", {
                              defaultValue:
                                "Daily token quota (blank = unlimited)",
                            })}
                            onChange={(event) =>
                              setQuotaEdit({
                                id: entry.id,
                                value: event.target.value,
                              })
                            }
                          />
                          <Button
                            size="sm"
                            disabled={rowBusy}
                            onClick={() => {
                              const trimmed = editing.value.trim();
                              const quota = trimmed ? Number(trimmed) : null;
                              if (
                                quota !== null &&
                                (!Number.isSafeInteger(quota) || quota <= 0)
                              ) {
                                setActionError(
                                  t("consumerKeys.invalidQuota", {
                                    defaultValue:
                                      "Daily token quota must be a positive integer.",
                                  }),
                                );
                                return;
                              }
                              setQuotaEdit(null);
                              void withBusy(entry.id, async () => {
                                replaceKey(
                                  await api.updateConsumerKey(entry.id, {
                                    dailyTokenQuota: quota,
                                  }),
                                );
                              });
                            }}
                          >
                            {t("consumerKeys.saveQuota", {
                              defaultValue: "Save quota",
                            })}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setQuotaEdit(null)}
                          >
                            {t("consumerKeys.cancel", {
                              defaultValue: "Cancel",
                            })}
                          </Button>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={rowBusy}
                          onClick={() =>
                            setQuotaEdit({
                              id: entry.id,
                              value:
                                entry.dailyTokenQuota === null
                                  ? ""
                                  : String(entry.dailyTokenQuota),
                            })
                          }
                        >
                          {t("consumerKeys.editQuota", {
                            defaultValue: "Edit quota",
                          })}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** OWNER-gated wrapper — lower tiers see the standard owner-only notice. */
export function ConsumerKeyPanel({ api }: { api?: ConsumerKeyPanelApi }) {
  return (
    <RoleGate minRole="OWNER" fallback={<OwnerOnlyNotice />}>
      <ConsumerKeyPanelBody {...(api ? { api } : {})} />
    </RoleGate>
  );
}
