import { Input, Label } from "@elizaos/ui";
import { ShieldCheck } from "lucide-react";
import { parseAmount } from "./helpers";
import type { AutoApproveConfig } from "./types";

export function AutoApproveSection({
  config,
  onChange,
}: {
  config: AutoApproveConfig;
  onChange: (config: AutoApproveConfig) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs-tight text-muted">
          Auto-approve below this amount (USD)
        </Label>
        <div className="relative w-40">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs-tight text-muted pointer-events-none">
            $
          </span>
          <Input
            type="text"
            inputMode="decimal"
            value={config.threshold}
            onChange={(e) => {
              const v = e.target.value.slice(0, 32);
              if (/^(?:\d+(?:\.\d*)?|\.\d*)?$/.test(v))
                onChange({ threshold: v });
            }}
            className="h-8 text-sm pl-7 tabular-nums"
            placeholder="5"
          />
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-lg bg-accent/5 border border-accent/15 px-3 py-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-accent shrink-0" />
        <div className="text-xs-tight text-muted">
          Under{" "}
          <span className="font-semibold text-txt">
            ${parseAmount(config.threshold)}
          </span>{" "}
          auto-approved across all chains
        </div>
      </div>
    </div>
  );
}

export function autoApproveSummary(config: AutoApproveConfig): string {
  return `Under $${config.threshold}`;
}
