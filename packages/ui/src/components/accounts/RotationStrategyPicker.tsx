/**
 * Compact selector for choosing how a provider rotates among linked accounts.
 * Calls `onChange` with the chosen strategy; the caller is responsible for
 * routing that through `client.patchProviderStrategy`.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check } from "lucide-react";
import type { AccountStrategy } from "../../api/client-agent";
import { CONFIG_SELECT_FLOATING_LAYER_NAME } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { useAppSelector } from "../../state";
import { Select, SelectTrigger, SelectValue } from "../ui/select";

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
          className="h-8 w-[160px] gap-1 truncate whitespace-nowrap rounded-sm border border-border bg-card text-xs [&>span]:truncate"
        >
          <SelectValue
            placeholder={t("accounts.strategy.choose", {
              defaultValue: "Choose strategy",
            })}
          />
        </SelectTrigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            data-floating-layer={CONFIG_SELECT_FLOATING_LAYER_NAME}
            position="popper"
            sideOffset={4}
            align="end"
            collisionPadding={16}
            style={{
              width: "min(18rem, calc(100vw - 2rem))",
              backgroundColor: "var(--card, #151518)",
              borderColor: "var(--border, rgba(255, 255, 255, 0.18))",
            }}
            className="relative z-[12000] overflow-hidden rounded-sm border text-txt shadow-md"
          >
            <SelectPrimitive.Viewport className="w-full p-1">
              {STRATEGY_OPTIONS.map((option) => (
                // Only the label lives inside ItemText — that is what Radix mirrors
                // into the (fixed-width) trigger. The description is a sibling, so
                // it shows in the dropdown list but never overflows the trigger.
                <SelectPrimitive.Item
                  key={option.id}
                  value={option.id}
                  className={cn(
                    "flex w-full cursor-default select-none items-start gap-1.5 rounded-sm py-1.5 pl-2 pr-2 outline-none",
                    "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                    "data-[highlighted]:bg-bg-accent",
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <SelectPrimitive.ItemText>
                      <span className="text-sm font-medium text-txt">
                        {t(option.labelKey, {
                          defaultValue: option.labelFallback,
                        })}
                      </span>
                    </SelectPrimitive.ItemText>
                    <span className="text-xs text-muted">
                      {t(option.descriptionKey, {
                        defaultValue: option.descriptionFallback,
                      })}
                    </span>
                  </div>
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                    <SelectPrimitive.ItemIndicator>
                      <Check className="h-3 w-3" />
                    </SelectPrimitive.ItemIndicator>
                  </span>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </Select>
    </div>
  );
}
