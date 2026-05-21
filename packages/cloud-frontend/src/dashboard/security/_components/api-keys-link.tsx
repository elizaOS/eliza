import { BrandButton, BrandCard, CornerBrackets } from "@elizaos/ui";
import { KeyRound } from "lucide-react";
import { Link } from "react-router-dom";

export function ApiKeysLink() {
  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-sm border border-blue-500/40 bg-blue-500/20 p-2">
            <KeyRound className="h-4 w-4 text-blue-300" />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-medium text-white">API keys</p>
            <p className="text-xs text-white/60">
              Manage long-lived keys, their scopes, and per-key audit history.
            </p>
          </div>
        </div>
        <Link to="/dashboard/api-keys">
          <BrandButton variant="outline" size="sm">
            Manage keys
          </BrandButton>
        </Link>
      </div>
    </BrandCard>
  );
}
