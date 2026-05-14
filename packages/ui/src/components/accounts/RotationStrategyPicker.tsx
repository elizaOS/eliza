/**
 * RotationStrategyPicker — compact `Select` exposing the four account
 * rotation strategies. Calls `onChange` with the chosen strategy; the
 * caller is responsible for routing that through `client.patchProviderStrategy`.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import type { AccountStrategy } from "../../api/client-agent";
import { useApp } from "../../state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

interface RotationStrategyPickerProps {
  providerId: LinkedAccountProviderId;
  value: AccountStrategy | undefined;
  onChange: (strategy: AccountStrategy) => void;
  disabled?: boolean;
}

interface StrategyOption {
  id: AccountStrategy;
  labelKey: string;
  labelFallback: string;
  descriptionKey: string;
  descriptionFallback: string;
}

const STRATEGY_OPTIONS: readonly StrategyOption[] = [
  {
    id: "priority",
    labelKey: "accounts.strategy.priority.label",
    labelFallback: "Priority",
    descriptionKey: "accounts.strategy.priority.description",
    descriptionFallback: "Always prefer the top healthy account.",
  },
  {
    id: "round-robin",
    labelKey: "accounts.strategy.roundRobin.label",
    labelFallback: "Round-robin",
    descriptionKey: "accounts.strategy.roundRobin.description",
    descriptionFallback: "Alternate across enabled accounts.",
  },
  {
    id: "least-used",
    labelKey: "accounts.strategy.leastUsed.label",
    labelFallback: "Least used",
    descriptionKey: "accounts.strategy.leastUsed.description",
    descriptionFallback: "Prefer the account with the lowest current usage.",
  },
  {
    id: "quota-aware",
    labelKey: "accounts.strategy.quotaAware.label",
    labelFallback: "Quota-aware",
    descriptionKey: "accounts.strategy.quotaAware.description",
    descriptionFallback: "Skip accounts above 85% utilization.",
  },
];

export function RotationStrategyPicker({
  providerId,
  value,
  onChange,
  disabled,
}: RotationStrategyPickerProps) {
  const { t } = useApp();
  const resolved: AccountStrategy = value ?? "priority";

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
        {t("accounts.strategy.label", { defaultValue: "Strategy" })}
      </span>
      <Select
        value={resolved}
        onValueChange={(next) => {
          if (next !== resolved) onChange(next as AccountStrategy);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          id={`rotation-strategy-${providerId}`}
          className="h-8 w-[160px] rounded-lg border border-border bg-card text-xs"
        >
          <SelectValue
            placeholder={t("accounts.strategy.choose", {
              defaultValue: "Choose strategy",
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {STRATEGY_OPTIONS.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <span className="text-sm font-medium text-txt">
                  {t(option.labelKey, { defaultValue: option.labelFallback })}
                </span>
                <span className="text-xs text-muted">
                  {t(option.descriptionKey, {
                    defaultValue: option.descriptionFallback,
                  })}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
