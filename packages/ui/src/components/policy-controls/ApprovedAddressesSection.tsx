import { Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  approvedAddressValue,
  chainTypeLabel,
  isValidAddress,
} from "./helpers";
import type { ApprovedAddressEntry, ApprovedAddressesConfig } from "./types";

export function ApprovedAddressesSection({
  config,
  onChange,
}: {
  config: ApprovedAddressesConfig;
  onChange: (config: ApprovedAddressesConfig) => void;
}) {
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);

  const entries: ApprovedAddressEntry[] = useMemo(
    () =>
      (config.addresses ?? []).map((addr) => {
        if (typeof addr !== "string") {
          return {
            address: addr.address,
            label: addr.label,
          };
        }
        return {
          address: addr,
          label: config.labels?.[addr] ?? "",
        };
      }),
    [config],
  );

  const handleAdd = useCallback(() => {
    const trimmed = newAddress.trim();
    if (!trimmed) return;
    if (!isValidAddress(trimmed)) {
      setAddressError("Invalid address format (EVM 0x... or Solana base58)");
      return;
    }
    if (
      config.addresses.some((entry) => approvedAddressValue(entry) === trimmed)
    ) {
      setAddressError("Already in list");
      return;
    }
    onChange({
      ...config,
      addresses: [...config.addresses, trimmed],
      labels: {
        ...config.labels,
        ...(newLabel.trim() ? { [trimmed]: newLabel.trim() } : {}),
      },
    });
    setNewAddress("");
    setNewLabel("");
    setAddressError(null);
  }, [newAddress, newLabel, config, onChange]);

  const handleRemove = useCallback(
    (addr: string) => {
      const labels = { ...config.labels };
      delete labels[addr];
      onChange({
        ...config,
        addresses: config.addresses.filter(
          (entry) => approvedAddressValue(entry) !== addr,
        ),
        labels,
      });
    },
    [config, onChange],
  );

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex items-center gap-2">
        <span
          className={`text-xs-tight px-2 py-0.5 rounded-full font-medium ${
            config.mode === "whitelist"
              ? "bg-ok/15 text-ok"
              : "bg-danger/15 text-danger"
          }`}
        >
          {config.mode === "whitelist" ? "Allowlist" : "Blocklist"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs-tight h-6 px-2"
          onClick={() =>
            onChange({
              ...config,
              mode: config.mode === "whitelist" ? "blacklist" : "whitelist",
            })
          }
        >
          Switch to {config.mode === "whitelist" ? "blocklist" : "allowlist"}
        </Button>
      </div>

      {/* Address list */}
      {entries.length > 0 ? (
        <div className="space-y-1 max-h-[180px] overflow-y-auto">
          {entries.map((entry) => {
            const chain = chainTypeLabel(entry.address);
            return (
              <div
                key={entry.address}
                className="flex items-center gap-2 rounded-lg bg-bg/50 px-3 py-1.5 group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs-tight font-mono text-txt truncate">
                      {entry.address}
                    </span>
                    {chain && (
                      <span className="text-3xs text-muted bg-muted/10 px-1.5 py-0.5 rounded shrink-0">
                        {chain}
                      </span>
                    )}
                  </div>
                  {entry.label && (
                    <div className="text-2xs text-muted">{entry.label}</div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-danger hover:text-danger"
                  onClick={() => handleRemove(entry.address)}
                  aria-label={`Remove ${entry.label || entry.address}`}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-xs-tight text-muted/60 py-1">
          {config.mode === "whitelist"
            ? "No addresses — agent can't send anywhere yet."
            : "No addresses blocked."}
        </div>
      )}

      {/* Add new */}
      <div className="flex gap-2">
        <Input
          type="text"
          placeholder="EVM or Solana address"
          value={newAddress}
          onChange={(e) => {
            setNewAddress(e.target.value);
            setAddressError(null);
          }}
          className="flex-1 h-8 text-xs font-mono"
        />
        <Input
          type="text"
          placeholder="Label"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          className="w-24 h-8 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2.5"
          onClick={handleAdd}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
      {addressError && (
        <div className="text-xs-tight text-danger">{addressError}</div>
      )}
    </div>
  );
}

export function addressSummary(config: ApprovedAddressesConfig): string {
  const count = config.addresses?.length ?? 0;
  const mode = config.mode === "whitelist" ? "allowed" : "blocked";
  return count === 0 ? `No addresses ${mode}` : `${count} ${mode}`;
}
