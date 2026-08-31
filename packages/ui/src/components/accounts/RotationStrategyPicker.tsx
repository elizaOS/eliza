/**
 * Compact selector for choosing how a provider rotates among linked accounts.
 * Calls `onChange` with the chosen strategy; the caller is responsible for
 * routing that through `client.patchProviderStrategy`.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import type { AccountStrategy } from "../../api/client-agent";
import { useAppSelector } from "../../state/app-store";
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
  {
    id: "reset-soonest",
    labelKey: "accounts.strategy.resetSoonest.label",
    labelFallback: "Reset-soonest",
    descriptionKey: "accounts.strategy.resetSoonest.description",
    descriptionFallback:
      "Spend the account whose weekly limit resets first; hold freshly-reset accounts in reserve.",
  },
  {
    id: "drain-soonest-reset",
    labelKey: "accounts.strategy.drainSoonestReset.label",
    labelFallback: "Drain soonest reset",
    descriptionKey: "accounts.strategy.drainSoonestReset.description",
    descriptionFallback:
      "Prefer hand-set priority, then the account whose relevant weekly limit resets soonest.",
  },
];

export function RotationStrategyPicker({
  providerId,
  value,
  onChange,
  disabled,
}: RotationStrategyPickerProps) {
  const t = useAppSelector((s) => s.t);
  const resolved: AccountStrategy =
    value ??
    (providerId === "anthropic-subscription"
      ? "drain-soonest-reset"
      : "priority");

  return (
    <div className="flex items-center gap-2">
      <span className="text-2xs font-medium uppercase tracking-wider text-muted">
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
          variant="accountCompact"
          aria-label={t("accounts.strategy.label", {
            defaultValue: "Strategy",
          })}
          id={`rotation-strategy-${providerId}`}
          className="w-[160px] gap-1 truncate whitespace-nowrap [&>span]:truncate"
        >
          <SelectValue
            placeholder={t("accounts.strategy.choose", {
              defaultValue: "Choose strategy",
            })}
          />
        </SelectTrigger>
        <SelectContent
          position="popper"
          sideOffset={4}
          align="end"
          collisionPadding={16}
          className="w-[min(18rem,calc(100vw-2rem))]"
        >
          {STRATEGY_OPTIONS.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              description={t(option.descriptionKey, {
                defaultValue: option.descriptionFallback,
              })}
            >
              <span className="text-sm font-medium text-txt">
                {t(option.labelKey, {
                  defaultValue: option.labelFallback,
                })}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
