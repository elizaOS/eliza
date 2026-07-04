/**
 * Per-slot inference routing controls: a routing-policy selector (manual / auto
 * by device / on-device only / cloud only) plus a preferred-provider dropdown
 * per agent model slot. Agent-controllable via useAgentElement; reads device
 * tier and public registrations from the local-inference API.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import type {
  AgentModelSlot,
  DeviceTierResult,
  PublicRegistration,
  RoutingPolicy,
  RoutingPreferences,
} from "../../api/client-local-inference";
import { useIntervalWhenDocumentVisible } from "../../hooks/useDocumentVisibility";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Select, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { SettingsSelectTrigger } from "../ui/settings-controls";
import { LOCAL_INFERENCE_SLOT_DESCRIPTORS } from "./slot-metadata";

const PREFERRED_AUTO_VALUE = "__auto__";

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
    value: "auto",
    labelKey: "routingmatrix.policy.auto.label",
    label: "Auto (by device)",
    hintKey: "routingmatrix.policy.auto.hint",
    hint: "Run local when this device can handle it, else cloud.",
  },
  {
    value: "local-only",
    labelKey: "routingmatrix.policy.localOnly.label",
    label: "On-device only",
    hintKey: "routingmatrix.policy.localOnly.hint",
    hint: "Always run on this device; never use cloud.",
  },
  {
    value: "cloud-only",
    labelKey: "routingmatrix.policy.cloudOnly.label",
    label: "Cloud only",
    hintKey: "routingmatrix.policy.cloudOnly.hint",
    hint: "Always use cloud; never run on-device.",
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
  const [deviceTier, setDeviceTier] = useState<DeviceTierResult | null>(null);
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

  const refreshRouting = useCallback(async () => {
    try {
      const data = await client.getLocalInferenceRouting();
      setRegistrations(data.registrations);
      setPreferences(data.preferences);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("routingmatrix.loadError", {
              defaultValue: "Failed to load routing",
            }),
      );
    }
  }, [t]);

  useEffect(() => {
    void refreshRouting();
  }, [refreshRouting]);

  useIntervalWhenDocumentVisible(() => void refreshRouting(), 15_000);

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await client.getLocalInferenceDeviceTier();
      if (active) setDeviceTier(result);
    })();
    return () => {
      active = false;
    };
  }, []);

  // For an "Auto" slot (no preferred provider pinned) the runtime resolves
  // on-device vs cloud from the device tier: MAX/GOOD run locally, OKAY/POOR
  // route to cloud. Surface the same resolution the runtime will make.
  const autoResolution = useCallback(
    (policy: RoutingPolicy): { onDevice: boolean; line: string } | null => {
      if (!deviceTier) return null;
      if (policy !== "prefer-local" && policy !== "cheapest") return null;
      const onDevice = deviceTier.tier === "MAX" || deviceTier.tier === "GOOD";
      const line = onDevice
        ? t("routingmatrix.autoOnDevice", {
            tier: deviceTier.tier,
            defaultValue: "Auto: on-device · {{tier}} tier",
          })
        : t("routingmatrix.autoCloud", {
            tier: deviceTier.tier,
            defaultValue: "Auto: cloud · device is {{tier}}",
          });
      return { onDevice, line };
    },
    [deviceTier, t],
  );

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
          // The auto-resolution hint only applies when no provider is pinned.
          const resolution = preferred === "" ? autoResolution(policy) : null;
          return (
            <RoutingSlotRow
              key={slot}
              slot={slot}
              label={label}
              candidates={candidates}
              policy={policy}
              preferred={preferred}
              disabled={busySlots.has(slot)}
              resolution={resolution}
              onPolicyChange={handlePolicy}
              onPreferredChange={handlePreferred}
            />
          );
        })}
      </div>
    </section>
  );
}

interface RoutingSlotRowProps {
  slot: AgentModelSlot;
  label: string;
  candidates: PublicRegistration[];
  policy: RoutingPolicy;
  preferred: string;
  disabled: boolean;
  resolution: { onDevice: boolean; line: string } | null;
  onPolicyChange: (slot: AgentModelSlot, policy: RoutingPolicy) => void;
  onPreferredChange: (slot: AgentModelSlot, provider: string | null) => void;
}

function RoutingSlotRow({
  slot,
  label,
  candidates,
  policy,
  preferred,
  disabled,
  resolution,
  onPolicyChange,
  onPreferredChange,
}: RoutingSlotRowProps) {
  const { t } = useTranslation();

  const policyLabel = t("routingmatrix.policyLabel", {
    defaultValue: "Policy",
  });
  const preferredLabel = t("routingmatrix.preferredProvider", {
    defaultValue: "Preferred provider",
  });

  const policyAgent = useAgentElement<HTMLButtonElement>({
    id: `routing-policy-${slot}`,
    role: "select",
    label: `${label} ${policyLabel}`,
    group: "model-routing",
    status: policy,
    options: POLICIES.map((p) => p.value),
    getValue: () => policy,
    onFill: disabled
      ? undefined
      : (next: string) => onPolicyChange(slot, next as RoutingPolicy),
  });

  const preferredAgent = useAgentElement<HTMLButtonElement>({
    id: `routing-preferred-${slot}`,
    role: "select",
    label: `${label} ${preferredLabel}`,
    group: "model-routing",
    status: preferred || undefined,
    options: candidates.map((c) => c.provider),
    getValue: () => preferred,
    onFill: disabled
      ? undefined
      : (next: string) => onPreferredChange(slot, next || null),
  });

  return (
    <div className="rounded-sm border border-border bg-card p-3 flex flex-col gap-2">
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
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted">{policyLabel}</span>
          <Select
            value={policy}
            disabled={disabled}
            onValueChange={(value) =>
              void onPolicyChange(slot, value as RoutingPolicy)
            }
          >
            <SettingsSelectTrigger
              ref={policyAgent.ref}
              variant="filter"
              aria-label={`${label} ${policyLabel}`}
              {...policyAgent.agentProps}
            >
              <SelectValue />
            </SettingsSelectTrigger>
            <SelectContent>
              {POLICIES.map((p) => (
                <SelectItem
                  key={p.value}
                  value={p.value}
                  title={t(p.hintKey, { defaultValue: p.hint })}
                >
                  {t(p.labelKey, { defaultValue: p.label })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted">
            {preferredLabel}
            {policy !== "manual" &&
              t("routingmatrix.manualOnly", {
                defaultValue: " (manual only)",
              })}
          </span>
          <Select
            value={preferred || PREFERRED_AUTO_VALUE}
            disabled={disabled}
            onValueChange={(value) =>
              void onPreferredChange(
                slot,
                value === PREFERRED_AUTO_VALUE ? null : value,
              )
            }
          >
            <SettingsSelectTrigger
              ref={preferredAgent.ref}
              variant="filter"
              aria-label={`${label} ${preferredLabel}`}
              {...preferredAgent.agentProps}
            >
              <SelectValue />
            </SettingsSelectTrigger>
            <SelectContent>
              <SelectItem value={PREFERRED_AUTO_VALUE}>
                {t("routingmatrix.auto", { defaultValue: "Auto" })}
              </SelectItem>
              {candidates.map((c) => (
                <SelectItem key={c.provider} value={c.provider}>
                  {c.provider}
                  {typeof c.priority === "number"
                    ? t("routingmatrix.priority", {
                        priority: c.priority,
                        defaultValue: " (priority {{priority}})",
                      })
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {candidates.length === 0 ? (
        <div className="text-xs text-muted italic">
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
              className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted"
            >
              {c.provider}
            </span>
          ))}
        </div>
      )}
      {resolution ? (
        <div
          data-testid={`routing-auto-resolution-${slot}`}
          className={`flex items-center gap-1.5 text-[10px] ${
            resolution.onDevice ? "text-accent" : "text-muted"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              resolution.onDevice ? "bg-accent" : "bg-muted"
            }`}
            aria-hidden
          />
          <span>{resolution.line}</span>
        </div>
      ) : null}
    </div>
  );
}
