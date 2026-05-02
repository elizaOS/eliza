import type { PolicyRule, PolicyType } from "@stwd/sdk";
import { useState } from "react";
import { usePolicies } from "../hooks/usePolicies.js";
import { useStewardContext } from "../provider.js";
import type { PolicyControlsProps, PolicyExposure } from "../types.js";

const DEFAULT_LABELS: Record<PolicyType, string> = {
  "spending-limit": "Spending Limits",
  "approved-addresses": "Approved Addresses",
  "auto-approve-threshold": "Auto-Approve Threshold",
  "time-window": "Time Window",
  "rate-limit": "Rate Limit",
  "allowed-chains": "Allowed Chains",
  "reputation-threshold": "Reputation Threshold",
  "reputation-scaling": "Reputation Scaling",
};

const POLICY_DESCRIPTIONS: Record<PolicyType, string> = {
  "spending-limit": "Set maximum amounts per transaction, per day, and per week.",
  "approved-addresses": "Whitelist or blacklist specific addresses for transactions.",
  "auto-approve-threshold": "Transactions below this amount are auto-approved without review.",
  "time-window": "Restrict transactions to specific hours and days.",
  "rate-limit": "Limit the number of transactions per hour and per day.",
  "allowed-chains": "Restrict which blockchain networks can be used.",
  "reputation-threshold": "Require a minimum reputation score before an action can proceed.",
  "reputation-scaling": "Scale the allowed transaction size based on the current reputation score.",
};

const ALL_POLICY_TYPES = Object.keys(DEFAULT_LABELS) as PolicyType[];

/**
 * Human-friendly policy toggles. Respects tenant exposure config.
 */
export function PolicyControls({
  showTemplates = true,
  onSave,
  readOnly = false,
  labels: labelOverrides,
  className,
}: PolicyControlsProps) {
  const { features, tenantConfig } = useStewardContext();
  const { policies, isLoading, isSaving, error, setPolicies, applyTemplate } = usePolicies();
  const [editPolicies, setEditPolicies] = useState<PolicyRule[] | null>(null);
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!features.showPolicyControls) return null;

  const labels = { ...DEFAULT_LABELS, ...labelOverrides };
  const exposure = tenantConfig?.exposedPolicies;
  const templates = tenantConfig?.policyTemplates || [];

  const currentPolicies = editPolicies || policies;

  const getExposure = (type: PolicyType): PolicyExposure => {
    return exposure?.[type] || "visible";
  };

  const visibleTypes = ALL_POLICY_TYPES.filter((type) => getExposure(type) !== "hidden");

  const findPolicy = (type: PolicyType): PolicyRule | undefined =>
    currentPolicies.find((p) => p.type === type);

  const updatePolicy = (type: PolicyType, updates: Partial<PolicyRule>) => {
    if (readOnly) return;
    const existing = currentPolicies.find((p) => p.type === type);
    const updated = existing
      ? currentPolicies.map((p) => (p.type === type ? { ...p, ...updates } : p))
      : [
          ...currentPolicies,
          {
            id: `policy-${type}`,
            type,
            enabled: true,
            config: {},
            ...updates,
          } as PolicyRule,
        ];
    setEditPolicies(updated);
  };

  const updateConfig = (type: PolicyType, key: string, value: unknown) => {
    const policy = findPolicy(type);
    const config = { ...(policy?.config || {}), [key]: value };
    updatePolicy(type, { config });
  };

  const handleSave = async () => {
    if (!editPolicies) return;
    setSaveError(null);
    try {
      await setPolicies(editPolicies);
      setEditPolicies(null);
      onSave?.(editPolicies);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    }
  };

  const handleApplyTemplate = async (templateId: string) => {
    try {
      await applyTemplate(templateId);
      setShowTemplateModal(false);
      setEditPolicies(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to apply template");
    }
  };

  if (isLoading) {
    return (
      <div className={`stwd-card stwd-policy-controls ${className || ""}`}>
        <div className="stwd-loading">Loading policies...</div>
      </div>
    );
  }

  return (
    <div className={`stwd-card stwd-policy-controls ${className || ""}`}>
      <div className="stwd-policy-header">
        <h3 className="stwd-heading">Policy Controls</h3>
        {showTemplates && templates.length > 0 && !readOnly && (
          <button
            className="stwd-btn stwd-btn-secondary"
            onClick={() => setShowTemplateModal(true)}
          >
            Use Template
          </button>
        )}
      </div>

      {error && <div className="stwd-error-text">{error.message}</div>}

      <div className="stwd-policy-list">
        {visibleTypes.map((type) => {
          const policy = findPolicy(type);
          const isEnforced = getExposure(type) === "enforced";
          const isEnabled = policy?.enabled ?? false;

          return (
            <div key={type} className={`stwd-policy-item ${isEnforced ? "stwd-enforced" : ""}`}>
              <div className="stwd-policy-item-header">
                <div className="stwd-policy-info">
                  <div className="stwd-policy-name">
                    {isEnforced && (
                      <span className="stwd-lock-icon" title="Set by platform">
                        🔒
                      </span>
                    )}
                    {labels[type]}
                  </div>
                  <div className="stwd-policy-desc">{POLICY_DESCRIPTIONS[type]}</div>
                </div>
                <label className="stwd-toggle">
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    disabled={readOnly || isEnforced}
                    onChange={(e) => updatePolicy(type, { enabled: e.target.checked })}
                  />
                  <span className="stwd-toggle-slider" />
                </label>
              </div>

              {isEnabled && (
                <div className="stwd-policy-config">
                  <PolicyConfigEditor
                    type={type}
                    config={policy?.config || {}}
                    readOnly={readOnly || isEnforced}
                    onConfigChange={(key, val) => updateConfig(type, key, val)}
                  />
                </div>
              )}

              {isEnforced && (
                <div className="stwd-enforced-label">Set by platform — cannot be changed</div>
              )}
            </div>
          );
        })}
      </div>

      {editPolicies && !readOnly && (
        <div className="stwd-policy-actions">
          {saveError && <div className="stwd-error-text">{saveError}</div>}
          <button
            className="stwd-btn stwd-btn-secondary"
            onClick={() => setEditPolicies(null)}
            disabled={isSaving}
          >
            Cancel
          </button>
          <button className="stwd-btn stwd-btn-primary" onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Policies"}
          </button>
        </div>
      )}

      {/* Template Modal */}
      {showTemplateModal && (
        <div className="stwd-modal-overlay" onClick={() => setShowTemplateModal(false)}>
          <div className="stwd-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="stwd-heading">Choose a Template</h3>
            <div className="stwd-template-list">
              {templates.map((tpl) => (
                <div key={tpl.id} className="stwd-template-card">
                  <div className="stwd-template-name">{tpl.name}</div>
                  <div className="stwd-template-desc">{tpl.description}</div>
                  <button
                    className="stwd-btn stwd-btn-primary"
                    onClick={() => handleApplyTemplate(tpl.id)}
                    disabled={isSaving}
                  >
                    Apply
                  </button>
                </div>
              ))}
            </div>
            <button
              className="stwd-btn stwd-btn-secondary"
              onClick={() => setShowTemplateModal(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Per-policy config editors ───

interface PolicyConfigEditorProps {
  type: PolicyType;
  config: Record<string, unknown>;
  readOnly: boolean;
  onConfigChange: (key: string, value: unknown) => void;
}

function PolicyConfigEditor({ type, config, readOnly, onConfigChange }: PolicyConfigEditorProps) {
  switch (type) {
    case "spending-limit":
      return <SpendingLimitEditor config={config} readOnly={readOnly} onChange={onConfigChange} />;
    case "approved-addresses":
      return (
        <ApprovedAddressesEditor config={config} readOnly={readOnly} onChange={onConfigChange} />
      );
    case "auto-approve-threshold":
      return <AutoApproveEditor config={config} readOnly={readOnly} onChange={onConfigChange} />;
    case "time-window":
      return <TimeWindowEditor config={config} readOnly={readOnly} onChange={onConfigChange} />;
    case "rate-limit":
      return <RateLimitEditor config={config} readOnly={readOnly} onChange={onConfigChange} />;
    case "allowed-chains":
      return <AllowedChainsEditor config={config} readOnly={readOnly} onChange={onConfigChange} />;
    default:
      return null;
  }
}

// ─── Spending Limit ───
function SpendingLimitEditor({
  config,
  readOnly,
  onChange,
}: {
  config: Record<string, unknown>;
  readOnly: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const toEth = (wei: string | unknown) => {
    if (!wei || typeof wei !== "string") return "";
    try {
      return (Number(BigInt(wei)) / 1e18).toString();
    } catch {
      return String(wei);
    }
  };

  const toWei = (eth: string) => {
    try {
      return BigInt(Math.floor(parseFloat(eth) * 1e18)).toString();
    } catch {
      return "0";
    }
  };

  return (
    <div className="stwd-config-grid">
      <div className="stwd-config-field">
        <label>Max per transaction (ETH)</label>
        <input
          type="number"
          step="0.001"
          className="stwd-input"
          value={toEth(config.maxPerTx)}
          disabled={readOnly}
          onChange={(e) => onChange("maxPerTx", toWei(e.target.value))}
        />
      </div>
      <div className="stwd-config-field">
        <label>Max per day (ETH)</label>
        <input
          type="number"
          step="0.01"
          className="stwd-input"
          value={toEth(config.maxPerDay)}
          disabled={readOnly}
          onChange={(e) => onChange("maxPerDay", toWei(e.target.value))}
        />
      </div>
      <div className="stwd-config-field">
        <label>Max per week (ETH)</label>
        <input
          type="number"
          step="0.01"
          className="stwd-input"
          value={toEth(config.maxPerWeek)}
          disabled={readOnly}
          onChange={(e) => onChange("maxPerWeek", toWei(e.target.value))}
        />
      </div>
    </div>
  );
}

// ─── Approved Addresses ───
function ApprovedAddressesEditor({
  config,
  readOnly,
  onChange,
}: {
  config: Record<string, unknown>;
  readOnly: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const addresses = (config.addresses as string[]) || [];
  const mode = (config.mode as string) || "whitelist";
  const [newAddr, setNewAddr] = useState("");

  const addAddress = () => {
    if (newAddr && /^0x[0-9a-fA-F]{40}$/.test(newAddr)) {
      onChange("addresses", [...addresses, newAddr]);
      setNewAddr("");
    }
  };

  const removeAddress = (idx: number) => {
    onChange(
      "addresses",
      addresses.filter((_, i) => i !== idx),
    );
  };

  return (
    <div className="stwd-config-stack">
      <div className="stwd-config-field">
        <label>Mode</label>
        <select
          className="stwd-select"
          value={mode}
          disabled={readOnly}
          onChange={(e) => onChange("mode", e.target.value)}
        >
          <option value="whitelist">Whitelist (only these addresses)</option>
          <option value="blacklist">Blacklist (block these addresses)</option>
        </select>
      </div>
      <div className="stwd-address-list">
        {addresses.map((addr, i) => (
          <div key={i} className="stwd-address-item">
            <code>{addr}</code>
            {!readOnly && (
              <button
                className="stwd-btn stwd-btn-ghost stwd-btn-sm"
                onClick={() => removeAddress(i)}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      {!readOnly && (
        <div className="stwd-address-add">
          <input
            type="text"
            className="stwd-input"
            placeholder="0x..."
            value={newAddr}
            onChange={(e) => setNewAddr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAddress()}
          />
          <button className="stwd-btn stwd-btn-secondary" onClick={addAddress}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Auto-Approve Threshold ───
function AutoApproveEditor({
  config,
  readOnly,
  onChange,
}: {
  config: Record<string, unknown>;
  readOnly: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const toEth = (wei: string | unknown) => {
    if (!wei || typeof wei !== "string") return "";
    try {
      return (Number(BigInt(wei)) / 1e18).toString();
    } catch {
      return String(wei);
    }
  };

  const toWei = (eth: string) => {
    try {
      return BigInt(Math.floor(parseFloat(eth) * 1e18)).toString();
    } catch {
      return "0";
    }
  };

  return (
    <div className="stwd-config-stack">
      <p className="stwd-muted-text">
        Transactions below this amount will be automatically approved without human review.
      </p>
      <div className="stwd-config-field">
        <label>Threshold (ETH)</label>
        <input
          type="number"
          step="0.001"
          className="stwd-input"
          value={toEth(config.threshold)}
          disabled={readOnly}
          onChange={(e) => onChange("threshold", toWei(e.target.value))}
        />
      </div>
    </div>
  );
}

// ─── Time Window ───
function TimeWindowEditor({
  config,
  readOnly,
  onChange,
}: {
  config: Record<string, unknown>;
  readOnly: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const allowedHours = (config.allowedHours as Array<{
    start: number;
    end: number;
  }>) || [{ start: 9, end: 17 }];
  const allowedDays = (config.allowedDays as number[]) || [1, 2, 3, 4, 5];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const toggleDay = (day: number) => {
    const newDays = allowedDays.includes(day)
      ? allowedDays.filter((d) => d !== day)
      : [...allowedDays, day].sort();
    onChange("allowedDays", newDays);
  };

  const updateHours = (index: number, field: "start" | "end", value: number) => {
    const newHours = allowedHours.map((h, i) => (i === index ? { ...h, [field]: value } : h));
    onChange("allowedHours", newHours);
  };

  return (
    <div className="stwd-config-stack">
      <div className="stwd-config-field">
        <label>Active Hours</label>
        {allowedHours.map((hours, i) => (
          <div key={i} className="stwd-time-range">
            <input
              type="number"
              min={0}
              max={23}
              className="stwd-input stwd-input-sm"
              value={hours.start}
              disabled={readOnly}
              onChange={(e) => updateHours(i, "start", parseInt(e.target.value, 10))}
            />
            <span>to</span>
            <input
              type="number"
              min={0}
              max={23}
              className="stwd-input stwd-input-sm"
              value={hours.end}
              disabled={readOnly}
              onChange={(e) => updateHours(i, "end", parseInt(e.target.value, 10))}
            />
          </div>
        ))}
      </div>
      <div className="stwd-config-field">
        <label>Active Days</label>
        <div className="stwd-day-picker">
          {dayNames.map((name, i) => (
            <button
              key={i}
              className={`stwd-day-btn ${allowedDays.includes(i) ? "stwd-day-active" : ""}`}
              disabled={readOnly}
              onClick={() => toggleDay(i)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Rate Limit ───
function RateLimitEditor({
  config,
  readOnly,
  onChange,
}: {
  config: Record<string, unknown>;
  readOnly: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div className="stwd-config-grid">
      <div className="stwd-config-field">
        <label>Max transactions per hour</label>
        <input
          type="number"
          min={1}
          className="stwd-input"
          value={(config.maxTxPerHour as number) || 10}
          disabled={readOnly}
          onChange={(e) => onChange("maxTxPerHour", parseInt(e.target.value, 10))}
        />
      </div>
      <div className="stwd-config-field">
        <label>Max transactions per day</label>
        <input
          type="number"
          min={1}
          className="stwd-input"
          value={(config.maxTxPerDay as number) || 100}
          disabled={readOnly}
          onChange={(e) => onChange("maxTxPerDay", parseInt(e.target.value, 10))}
        />
      </div>
    </div>
  );
}

// ─── Allowed Chains ───
function AllowedChainsEditor({
  config,
  readOnly,
  onChange,
}: {
  config: Record<string, unknown>;
  readOnly: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const chains = (config.chains as string[]) || [];
  const availableChains = [
    { caip2: "eip155:1", name: "Ethereum", symbol: "ETH" },
    { caip2: "eip155:8453", name: "Base", symbol: "ETH" },
    { caip2: "eip155:137", name: "Polygon", symbol: "POL" },
    { caip2: "eip155:42161", name: "Arbitrum", symbol: "ETH" },
    { caip2: "eip155:56", name: "BSC", symbol: "BNB" },
    {
      caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      name: "Solana",
      symbol: "SOL",
    },
  ];

  const toggleChain = (caip2: string) => {
    const newChains = chains.includes(caip2)
      ? chains.filter((c) => c !== caip2)
      : [...chains, caip2];
    onChange("chains", newChains);
  };

  return (
    <div className="stwd-config-stack">
      <div className="stwd-chain-checklist">
        {availableChains.map((chain) => (
          <label key={chain.caip2} className="stwd-chain-option">
            <input
              type="checkbox"
              checked={chains.includes(chain.caip2)}
              disabled={readOnly}
              onChange={() => toggleChain(chain.caip2)}
            />
            <span className="stwd-chain-name">{chain.name}</span>
            <span className="stwd-chain-symbol">{chain.symbol}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
