import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import type {
  AgentModelSlot,
  PublicRegistration,
  RoutingPolicy,
  RoutingPreferences,
} from "../../api/client-local-inference";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { LOCAL_INFERENCE_SLOT_DESCRIPTORS } from "./slot-metadata";

const DEFAULT_POLICY: RoutingPolicy = "prefer-local";

const POLICIES: Array<{
  value: RoutingPolicy;
  labelKey: string;
  label: string;
  hintKey: string;
  hint: string;
}> = [
  {
    value: "manual",
    labelKey: "routingmatrix.policy.manual.label",
    label: "Manual",
    hintKey: "routingmatrix.policy.manual.hint",
    hint: "Use the preferred provider below.",
  },
  {
    value: "cheapest",
    labelKey: "routingmatrix.policy.cheapest.label",
    label: "Cheapest",
    hintKey: "routingmatrix.policy.cheapest.hint",
    hint: "Lowest $/token. Local is free.",
  },
  {
    value: "fastest",
    labelKey: "routingmatrix.policy.fastest.label",
    label: "Fastest",
    hintKey: "routingmatrix.policy.fastest.hint",
    hint: "Lowest measured p50 latency.",
  },
  {
    value: "prefer-local",
    labelKey: "routingmatrix.policy.preferLocal.label",
    label: "Prefer local",
    hintKey: "routingmatrix.policy.preferLocal.hint",
    hint: "Try on-device first, fall through to cloud.",
  },
  {
    value: "round-robin",
    labelKey: "routingmatrix.policy.roundRobin.label",
    label: "Round robin",
    hintKey: "routingmatrix.policy.roundRobin.hint",
    hint: "Distribute load across all eligible providers.",
  },
];

export function RoutingMatrix() {
  useRenderGuard("RoutingMatrix");
  const { t } = useTranslation();
  const [registrations, setRegistrations] = useState<PublicRegistration[]>([]);
  const [preferences, setPreferences] = useState<RoutingPreferences>({
    preferredProvider: {},
    policy: {},
  });
  const [error, setError] = useState<string | null>(null);
  const [busySlots, setBusySlots] = useState<Set<AgentModelSlot>>(
    () => new Set(),
  );
  const requestSeqRef = useRef(new Map<AgentModelSlot, number>());

  const setSlotBusy = useCallback((slot: AgentModelSlot, busy: boolean) => {
    setBusySlots((prev) => {
      const next = new Set(prev);
      if (busy) {
        next.add(slot);
      } else {
        next.delete(slot);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    let active = true;
    const refreshIfActive = async () => {
      try {
        const data = await client.getLocalInferenceRouting();
        if (!active) return;
        setRegistrations(data.registrations);
        setPreferences(data.preferences);
        setError(null);
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : t("routingmatrix.loadError", {
                  defaultValue: "Failed to load routing",
                }),
          );
        }
      }
    };
    void refreshIfActive();
    const interval = setInterval(() => void refreshIfActive(), 15_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [t]);

  const handlePolicy = useCallback(
    async (slot: AgentModelSlot, policy: RoutingPolicy) => {
      const requestId = (requestSeqRef.current.get(slot) ?? 0) + 1;
      requestSeqRef.current.set(slot, requestId);
      setSlotBusy(slot, true);
      try {
        const res = await client.setLocalInferencePolicy(slot, policy);
        if (requestSeqRef.current.get(slot) === requestId) {
          setPreferences(res.preferences);
          setError(null);
        }
      } catch (err) {
        if (requestSeqRef.current.get(slot) === requestId) {
          setError(
            err instanceof Error
              ? err.message
              : t("routingmatrix.policyError", {
                  defaultValue: "Failed to update policy",
                }),
          );
        }
      } finally {
        if (requestSeqRef.current.get(slot) === requestId) {
          setSlotBusy(slot, false);
        }
      }
    },
    [setSlotBusy, t],
  );

  const handlePreferred = useCallback(
    async (slot: AgentModelSlot, provider: string | null) => {
      const requestId = (requestSeqRef.current.get(slot) ?? 0) + 1;
      requestSeqRef.current.set(slot, requestId);
      setSlotBusy(slot, true);
      try {
        const res = await client.setLocalInferencePreferredProvider(
          slot,
          provider,
        );
        if (requestSeqRef.current.get(slot) === requestId) {
          setPreferences(res.preferences);
          setError(null);
        }
      } catch (err) {
        if (requestSeqRef.current.get(slot) === requestId) {
          setError(
            err instanceof Error
              ? err.message
              : t("routingmatrix.updateError", {
                  defaultValue: "Failed to update preferred provider",
                }),
          );
        }
      } finally {
        if (requestSeqRef.current.get(slot) === requestId) {
          setSlotBusy(slot, false);
        }
      }
    },
    [setSlotBusy, t],
  );

  return (
    <section className="flex flex-col gap-3">
      <header>
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted">
          {t("routingmatrix.title", { defaultValue: "Model routing" })}
        </h3>
      </header>
      {error ? (
        <div className="rounded-sm border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {LOCAL_INFERENCE_SLOT_DESCRIPTORS.map(({ slot, modelType, label }) => {
          const candidates = registrations
            .filter((r) => r.modelType === modelType)
            .filter((r) => r.provider !== "eliza-router")
            .sort((a, b) => b.priority - a.priority);
          const policy = preferences.policy[slot] ?? DEFAULT_POLICY;
          const preferred = preferences.preferredProvider[slot] ?? "";
          const disabled = busySlots.has(slot);
          return (
            <div
              key={slot}
              className="rounded-sm border border-border bg-card p-3 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm" title={slot}>
                  {label}
                </span>
                <span
                  className={`h-2 w-2 rounded-full ${
                    candidates.length > 0 ? "bg-ok" : "bg-muted"
                  }`}
                  title={t("routingmatrix.availableProviders", {
                    count: candidates.length,
                    defaultValue: "{{count}} available providers",
                  })}
                  aria-hidden
                />
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">
                    {t("routingmatrix.policyLabel", { defaultValue: "Policy" })}
                  </span>
                  <select
                    value={policy}
                    disabled={disabled}
                    onChange={(e) =>
                      void handlePolicy(slot, e.target.value as RoutingPolicy)
                    }
                    className="rounded-sm border border-border bg-bg/50 px-2 py-1.5 text-sm"
                  >
                    {POLICIES.map((p) => (
                      <option
                        key={p.value}
                        value={p.value}
                        title={t(p.hintKey, { defaultValue: p.hint })}
                      >
                        {t(p.labelKey, { defaultValue: p.label })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">
                    {t("routingmatrix.preferredProvider", {
                      defaultValue: "Preferred provider",
                    })}
                    {policy !== "manual" &&
                      t("routingmatrix.manualOnly", {
                        defaultValue: " (manual only)",
                      })}
                  </span>
                  <select
                    value={preferred}
                    disabled={disabled}
                    onChange={(e) =>
                      void handlePreferred(slot, e.target.value || null)
                    }
                    className="rounded-sm border border-border bg-bg/50 px-2 py-1.5 text-sm disabled:opacity-60"
                  >
                    <option value="">
                      {t("routingmatrix.auto", { defaultValue: "Auto" })}
                    </option>
                    {candidates.map((c) => (
                      <option key={c.provider} value={c.provider}>
                        {c.provider}
                        {typeof c.priority === "number"
                          ? t("routingmatrix.priority", {
                              priority: c.priority,
                              defaultValue: " (priority {{priority}})",
                            })
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {candidates.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">
                  {t("routingmatrix.noProvider", {
                    defaultValue:
                      "No provider has registered a handler for this slot yet.",
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {candidates.map((c) => (
                    <span
                      key={c.provider}
                      className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {c.provider}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
