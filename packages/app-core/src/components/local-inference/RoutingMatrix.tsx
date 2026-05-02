import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import type {
  AgentModelSlot,
  PublicRegistration,
  RoutingPolicy,
  RoutingPreferences,
} from "../../api/client-local-inference";

const DEFAULT_POLICY: RoutingPolicy = "prefer-local";

const SLOTS: AgentModelSlot[] = [
  "TEXT_SMALL",
  "TEXT_LARGE",
  "TEXT_EMBEDDING",
  "OBJECT_SMALL",
  "OBJECT_LARGE",
];

const POLICIES: Array<{ value: RoutingPolicy; label: string; hint: string }> = [
  {
    value: "manual",
    label: "Manual",
    hint: "Use the preferred provider below.",
  },
  {
    value: "cheapest",
    label: "Cheapest",
    hint: "Lowest $/token. Local is free.",
  },
  { value: "fastest", label: "Fastest", hint: "Lowest measured p50 latency." },
  {
    value: "prefer-local",
    label: "Prefer local",
    hint: "Try on-device first, fall through to cloud.",
  },
  {
    value: "round-robin",
    label: "Round robin",
    hint: "Distribute load across all eligible providers.",
  },
];

// Runtime model type strings for each agent slot. Keep in sync with the
// server-side ModelType enum via router-handler.ts#slotToModelType.
const SLOT_MODEL_TYPE: Record<AgentModelSlot, string> = {
  TEXT_SMALL: "TEXT_SMALL",
  TEXT_LARGE: "TEXT_LARGE",
  TEXT_EMBEDDING: "TEXT_EMBEDDING",
  OBJECT_SMALL: "OBJECT_SMALL",
  OBJECT_LARGE: "OBJECT_LARGE",
};

const SLOT_LABEL: Record<AgentModelSlot, string> = {
  TEXT_SMALL: "Small text",
  TEXT_LARGE: "Large text",
  TEXT_EMBEDDING: "Embeddings",
  OBJECT_SMALL: "Small structured output",
  OBJECT_LARGE: "Large structured output",
};

export function RoutingMatrix() {
  const [registrations, setRegistrations] = useState<PublicRegistration[]>([]);
  const [preferences, setPreferences] = useState<RoutingPreferences>({
    preferredProvider: {},
    policy: {},
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<AgentModelSlot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await client.getLocalInferenceRouting();
      setRegistrations(data.registrations);
      setPreferences(data.preferences);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load routing");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handlePolicy = useCallback(
    async (slot: AgentModelSlot, policy: RoutingPolicy) => {
      setBusy(slot);
      try {
        const res = await client.setLocalInferencePolicy(slot, policy);
        setPreferences(res.preferences);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const handlePreferred = useCallback(
    async (slot: AgentModelSlot, provider: string | null) => {
      setBusy(slot);
      try {
        const res = await client.setLocalInferencePreferredProvider(
          slot,
          provider,
        );
        setPreferences(res.preferences);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  return (
    <section className="flex flex-col gap-3">
      <header>
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted">
          Model routing
        </h3>
      </header>
      {error ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {SLOTS.map((slot) => {
          const modelType = SLOT_MODEL_TYPE[slot];
          const candidates = registrations
            .filter((r) => r.modelType === modelType)
            .filter((r) => r.provider !== "eliza-router")
            .sort((a, b) => b.priority - a.priority);
          const policy = preferences.policy[slot] ?? DEFAULT_POLICY;
          const preferred = preferences.preferredProvider[slot] ?? "";
          const disabled = busy === slot;
          return (
            <div
              key={slot}
              className="rounded-xl border border-border bg-card p-3 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm" title={slot}>
                  {SLOT_LABEL[slot]}
                </span>
                <span
                  className={`h-2 w-2 rounded-full ${
                    candidates.length > 0 ? "bg-ok" : "bg-muted"
                  }`}
                  title={`${candidates.length} available provider${
                    candidates.length === 1 ? "" : "s"
                  }`}
                  aria-hidden
                />
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Policy</span>
                  <select
                    value={policy}
                    disabled={disabled}
                    onChange={(e) =>
                      void handlePolicy(slot, e.target.value as RoutingPolicy)
                    }
                    className="rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm"
                  >
                    {POLICIES.map((p) => (
                      <option key={p.value} value={p.value} title={p.hint}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">
                    Preferred provider
                    {policy !== "manual" && " (manual only)"}
                  </span>
                  <select
                    value={preferred}
                    disabled={disabled}
                    onChange={(e) =>
                      void handlePreferred(slot, e.target.value || null)
                    }
                    className="rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm disabled:opacity-60"
                  >
                    <option value="">Auto</option>
                    {candidates.map((c) => (
                      <option key={c.provider} value={c.provider}>
                        {c.provider}
                        {typeof c.priority === "number"
                          ? ` (priority ${c.priority})`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {candidates.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">
                  No provider has registered a handler for this slot yet.
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
