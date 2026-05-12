import { asRecord as asSharedRecord } from "@elizaos/shared";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Slider } from "../ui/slider";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { AlertTriangle } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import type {
  ApprovedAddressesConfig,
  PolicyRule,
  PolicyType,
  TimeWindowConfig,
} from "../policy-controls";
import {
  approvedAddressValue,
  chainTypeLabel,
  DAY_NAMES,
  DEFAULT_APPROVED_ADDRESSES,
  DEFAULT_AUTO_APPROVE,
  DEFAULT_RATE_LIMIT,
  DEFAULT_SPENDING,
  DEFAULT_TIME_WINDOW,
  findPolicy,
  getPolicyConfig,
  isValidAddress,
  TIMEZONES,
} from "../policy-controls";
import { StewardLogo } from "../steward/injected";
import { useSettingsSave } from "./settings-control-primitives";

const asRecord = (value: unknown): Record<string, unknown> =>
  asSharedRecord(value) ?? {};

/** Static hour options to avoid array-index-as-key lint issues. */
const HOUR_FROM_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  key: `from-${i}`,
  value: i,
  label: `${String(i).padStart(2, "0")}:00`,
}));

const HOUR_TO_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  key: `to-${i + 1}`,
  value: i + 1,
  label: `${String(i + 1).padStart(2, "0")}:00`,
}));

export function PolicyControlsView() {
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stewardConnected, setStewardConnected] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState("");
  const [confirmCallback, setConfirmCallback] = useState<(() => void) | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const status = await client.getStewardStatus();
        if (cancelled) return;
        setStewardConnected(status.connected);
        if (!status.connected) {
          setLoading(false);
          return;
        }
        const result = await client.getStewardPolicies();
        if (cancelled) return;
        setPolicies(result as PolicyRule[]);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load policies",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const performSave = useCallback(async () => {
    setError(null);
    try {
      await client.setStewardPolicies(policies);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save policies");
      throw err;
    }
  }, [policies]);

  const {
    saving,
    saveSuccess,
    handleSave,
    resetStatus: resetSaveStatus,
  } = useSettingsSave({
    onSave: performSave,
    errorFallback: "Failed to save policies",
  });

  const getPolicy = useCallback(
    (type: PolicyType) => findPolicy(policies, type),
    [policies],
  );

  const updatePolicy = useCallback(
    (type: PolicyType, updates: Partial<PolicyRule>) => {
      setPolicies((prev) => {
        const existing = prev.find((p) => p.type === type);
        if (existing) {
          return prev.map((p) => (p.type === type ? { ...p, ...updates } : p));
        }
        return [
          ...prev,
          {
            id: `${type}-${Date.now()}`,
            type,
            enabled: true,
            config: {},
            ...updates,
          },
        ];
      });
      setDirty(true);
      resetSaveStatus();
    },
    [resetSaveStatus],
  );

  const togglePolicy = useCallback(
    (
      type: PolicyType,
      enabled: boolean,
      defaultConfig: Record<string, unknown>,
    ) => {
      const existing = findPolicy(policies, type);
      if (!enabled && existing?.enabled) {
        setConfirmMessage(
          "Disabling this removes a safety guardrail. Are you sure?",
        );
        setConfirmCallback(() => () => updatePolicy(type, { enabled: false }));
        setConfirmOpen(true);
        return;
      }
      updatePolicy(type, {
        enabled,
        config: existing?.config ?? defaultConfig,
      });
    },
    [policies, updatePolicy],
  );

  // Extract configs (must be before early returns so hooks are unconditional)
  const autoApprovePolicy = getPolicy("auto-approve-threshold");
  const autoApproveConfig = getPolicyConfig<"auto-approve-threshold">(
    autoApprovePolicy,
    DEFAULT_AUTO_APPROVE,
  );

  const spendingPolicy = getPolicy("spending-limit");
  const spendingConfig = getPolicyConfig<"spending-limit">(
    spendingPolicy,
    DEFAULT_SPENDING,
  );

  const addressPolicy = getPolicy("approved-addresses");
  const addressConfig = getPolicyConfig<"approved-addresses">(
    addressPolicy,
    DEFAULT_APPROVED_ADDRESSES,
  );

  const rateLimitPolicy = getPolicy("rate-limit");
  const rateLimitConfig = getPolicyConfig<"rate-limit">(
    rateLimitPolicy,
    DEFAULT_RATE_LIMIT,
  );

  const timeWindowPolicy = getPolicy("time-window");
  const timeWindowConfig = getPolicyConfig<"time-window">(
    timeWindowPolicy,
    DEFAULT_TIME_WINDOW,
  );

  const normalizedAddresses = useMemo(
    () =>
      (addressConfig.addresses ?? []).map((addr) => approvedAddressValue(addr)),
    [addressConfig.addresses],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size={24} />
        <span className="ml-3 text-sm text-muted">Loading…</span>
      </div>
    );
  }

  if (!stewardConnected) {
    return (
      <div className="flex flex-col items-center gap-4 py-8 text-center">
        <StewardLogo size={48} className="opacity-30" />
        <p className="text-sm font-semibold text-txt">Steward Not Connected</p>
        <p className="text-xs text-muted max-w-sm">
          Connect your Steward instance to manage wallet policies.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0 divide-y divide-border/20">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 mb-4">
          <AlertTriangle className="h-4 w-4 text-danger shrink-0" />
          <span className="text-xs text-danger">{error}</span>
        </div>
      )}

      {/* Auto-Approve */}
      <PolicyRow
        title="Auto-Approve"
        desc={
          autoApprovePolicy?.enabled
            ? `Under $${autoApproveConfig.threshold ?? "5"}`
            : "Off"
        }
        enabled={autoApprovePolicy?.enabled ?? false}
        onToggle={(v) =>
          togglePolicy(
            "auto-approve-threshold",
            v,
            asRecord(DEFAULT_AUTO_APPROVE),
          )
        }
      >
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted whitespace-nowrap">
            Threshold
          </Label>
          <UsdField
            value={autoApproveConfig.threshold ?? "5"}
            onChange={(v) =>
              updatePolicy("auto-approve-threshold", {
                config: asRecord({ threshold: v }),
              })
            }
          />
        </div>
      </PolicyRow>

      {/* Spending Limits */}
      <PolicyRow
        title="Spending Limits"
        desc={
          spendingPolicy?.enabled
            ? `$${spendingConfig.maxPerTx}/tx · $${spendingConfig.maxPerDay}/day · $${spendingConfig.maxPerWeek}/wk`
            : "Off"
        }
        enabled={spendingPolicy?.enabled ?? false}
        onToggle={(v) =>
          togglePolicy("spending-limit", v, asRecord(DEFAULT_SPENDING))
        }
      >
        <div className="grid grid-cols-3 gap-3">
          <UsdFieldLabeled
            label="Per Tx"
            value={spendingConfig.maxPerTx}
            onChange={(v) =>
              updatePolicy("spending-limit", {
                config: asRecord({ ...spendingConfig, maxPerTx: v }),
              })
            }
          />
          <UsdFieldLabeled
            label="Daily"
            value={spendingConfig.maxPerDay}
            onChange={(v) =>
              updatePolicy("spending-limit", {
                config: asRecord({ ...spendingConfig, maxPerDay: v }),
              })
            }
          />
          <UsdFieldLabeled
            label="Weekly"
            value={spendingConfig.maxPerWeek}
            onChange={(v) =>
              updatePolicy("spending-limit", {
                config: asRecord({ ...spendingConfig, maxPerWeek: v }),
              })
            }
          />
        </div>
      </PolicyRow>

      {/* Rate Limits */}
      <PolicyRow
        title="Rate Limits"
        desc={
          rateLimitPolicy?.enabled
            ? `${rateLimitConfig.maxTxPerHour}/hr · ${rateLimitConfig.maxTxPerDay}/day`
            : "Off"
        }
        enabled={rateLimitPolicy?.enabled ?? false}
        onToggle={(v) =>
          togglePolicy("rate-limit", v, asRecord(DEFAULT_RATE_LIMIT))
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <SliderField
            label="Per Hour"
            value={rateLimitConfig.maxTxPerHour}
            min={1}
            max={100}
            onChange={(v) =>
              updatePolicy("rate-limit", {
                config: asRecord({ ...rateLimitConfig, maxTxPerHour: v }),
              })
            }
          />
          <SliderField
            label="Per Day"
            value={rateLimitConfig.maxTxPerDay}
            min={1}
            max={500}
            onChange={(v) =>
              updatePolicy("rate-limit", {
                config: asRecord({ ...rateLimitConfig, maxTxPerDay: v }),
              })
            }
          />
        </div>
      </PolicyRow>

      {/* Address Controls */}
      <PolicyRow
        title="Address Controls"
        desc={
          addressPolicy?.enabled
            ? `${normalizedAddresses.length} ${addressConfig.mode === "whitelist" ? "allowed" : "blocked"}`
            : "Off"
        }
        enabled={addressPolicy?.enabled ?? false}
        onToggle={(v) =>
          togglePolicy(
            "approved-addresses",
            v,
            asRecord(DEFAULT_APPROVED_ADDRESSES),
          )
        }
      >
        <AddressSection
          config={addressConfig}
          addresses={normalizedAddresses}
          onUpdate={(cfg) =>
            updatePolicy("approved-addresses", { config: asRecord(cfg) })
          }
        />
      </PolicyRow>

      {/* Time Restrictions */}
      <PolicyRow
        title="Time Restrictions"
        desc={
          timeWindowPolicy?.enabled
            ? `${timeWindowConfig.allowedDays?.length ?? 0} days`
            : "Off"
        }
        enabled={timeWindowPolicy?.enabled ?? false}
        onToggle={(v) =>
          togglePolicy("time-window", v, asRecord(DEFAULT_TIME_WINDOW))
        }
      >
        <TimeSection
          config={timeWindowConfig}
          onUpdate={(cfg) =>
            updatePolicy("time-window", { config: asRecord(cfg) })
          }
        />
      </PolicyRow>

      {/* Save */}
      {dirty && (
        <div className="flex items-center justify-end gap-3 pt-4 border-t-0">
          <span className="text-xs text-accent">Unsaved changes</span>
          <Button
            variant="default"
            size="sm"
            className="text-xs"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? (
              <>
                <Spinner size={14} />
                <span className="ml-1.5">Saving…</span>
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      )}
      {saveSuccess && !dirty && (
        <div className="pt-3 text-right border-t-0">
          <span className="text-xs text-ok">Saved</span>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Disable Policy"
        message={confirmMessage}
        confirmLabel="Disable"
        cancelLabel="Keep"
        variant="warn"
        onConfirm={() => {
          confirmCallback?.();
          setConfirmOpen(false);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────── */

function PolicyRow({
  title,
  desc,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  desc: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="py-3.5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-txt">{title}</div>
          <div className="text-xs text-muted mt-0.5">{desc}</div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={title}
        />
      </div>
      {enabled && children && <div className="mt-3">{children}</div>}
    </div>
  );
}

function UsdField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative w-28">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-2xs text-muted pointer-events-none">
        $
      </span>
      <Input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => {
          const v = e.target.value.slice(0, 32);
          if (/^(?:\d+(?:\.\d*)?|\.\d*)?$/.test(v)) onChange(v);
        }}
        className="h-8 text-xs pl-6 tabular-nums"
        placeholder="0"
      />
    </div>
  );
}

function UsdFieldLabeled({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs-tight text-muted">{label}</Label>
      <UsdField value={value} onChange={onChange} />
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between">
        <Label className="text-xs text-muted">{label}</Label>
        <span className="text-xs font-medium text-txt tabular-nums">
          {value}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={([v]: number[]) => onChange(v)}
      />
    </div>
  );
}

function AddressSection({
  config,
  addresses,
  onUpdate,
}: {
  config: ApprovedAddressesConfig;
  addresses: string[];
  onUpdate: (cfg: ApprovedAddressesConfig) => void;
}) {
  const [newAddr, setNewAddr] = useState("");
  const [addrError, setAddrError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = newAddr.trim();
    if (!trimmed) return;
    if (!isValidAddress(trimmed)) {
      setAddrError("Invalid address (EVM 0x... or Solana base58)");
      return;
    }
    if (
      config.addresses.some((entry) => approvedAddressValue(entry) === trimmed)
    ) {
      setAddrError("Already in list");
      return;
    }
    onUpdate({ ...config, addresses: [...config.addresses, trimmed] });
    setNewAddr("");
    setAddrError(null);
  };

  const handleRemove = (addr: string) => {
    const labels = { ...config.labels };
    delete labels[addr];
    onUpdate({
      ...config,
      addresses: config.addresses.filter(
        (entry) => approvedAddressValue(entry) !== addr,
      ),
      labels,
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button
          variant={config.mode === "whitelist" ? "default" : "ghost"}
          size="sm"
          className="text-xs-tight h-7"
          onClick={() => onUpdate({ ...config, mode: "whitelist" })}
        >
          Allowlist
        </Button>
        <Button
          variant={config.mode === "blacklist" ? "default" : "ghost"}
          size="sm"
          className="text-xs-tight h-7"
          onClick={() => onUpdate({ ...config, mode: "blacklist" })}
        >
          Blocklist
        </Button>
      </div>

      {addresses.length > 0 && (
        <div className="space-y-1">
          {addresses.map((addr) => {
            const chain = chainTypeLabel(addr);
            return (
              <div
                key={addr}
                className="flex items-center justify-between group text-xs-tight font-mono text-muted py-1"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <span className="truncate">{addr}</span>
                  {chain && (
                    <span className="text-3xs text-muted bg-muted/10 px-1.5 py-0.5 rounded shrink-0">
                      {chain}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="text-danger opacity-0 group-hover:opacity-100 text-2xs ml-2"
                  onClick={() => handleRemove(addr)}
                >
                  remove
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          type="text"
          value={newAddr}
          onChange={(e) => {
            setNewAddr(e.target.value);
            setAddrError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          placeholder="EVM or Solana address"
          className="h-8 text-xs font-mono flex-1"
        />
        <Button
          variant="ghost"
          size="sm"
          className="text-xs h-8"
          onClick={handleAdd}
        >
          Add
        </Button>
      </div>
      {addrError && (
        <div className="text-xs-tight text-danger">{addrError}</div>
      )}
    </div>
  );
}

function TimeSection({
  config,
  onUpdate,
}: {
  config: TimeWindowConfig;
  onUpdate: (cfg: TimeWindowConfig) => void;
}) {
  const hours = config.allowedHours?.[0] ?? { start: 9, end: 17 };
  const days = config.allowedDays ?? [1, 2, 3, 4, 5];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="space-y-1">
          <Label className="text-xs-tight text-muted">From</Label>
          <select
            value={hours.start}
            onChange={(e) =>
              onUpdate({
                ...config,
                allowedHours: [
                  { start: Number(e.target.value), end: hours.end },
                ],
              })
            }
            className="h-8 rounded-md border border-input bg-bg px-2 text-xs text-txt"
          >
            {HOUR_FROM_OPTIONS.map((h) => (
              <option key={h.key} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </div>
        <span className="text-muted text-xs mt-5">→</span>
        <div className="space-y-1">
          <Label className="text-xs-tight text-muted">To</Label>
          <select
            value={hours.end}
            onChange={(e) =>
              onUpdate({
                ...config,
                allowedHours: [
                  { start: hours.start, end: Number(e.target.value) },
                ],
              })
            }
            className="h-8 rounded-md border border-input bg-bg px-2 text-xs text-txt"
          >
            {HOUR_TO_OPTIONS.map((h) => (
              <option key={h.key} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex gap-1">
        {DAY_NAMES.map((name, i) => (
          <button
            key={name}
            type="button"
            className={`h-7 w-9 rounded text-2xs font-medium transition-colors ${
              days.includes(i)
                ? "bg-accent/20 text-accent border border-accent/30"
                : "bg-bg text-muted border border-border/30 hover:border-border/50"
            }`}
            onClick={() => {
              const next = days.includes(i)
                ? days.filter((d) => d !== i)
                : [...days, i].sort();
              onUpdate({ ...config, allowedDays: next });
            }}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="space-y-1">
        <Label className="text-xs-tight text-muted">Timezone</Label>
        <select
          value={
            config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
          }
          onChange={(e) => onUpdate({ ...config, timezone: e.target.value })}
          className="h-8 rounded-md border border-input bg-bg px-2 text-xs text-txt w-full"
        >
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
