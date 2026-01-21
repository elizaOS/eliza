"use client";

import { Info } from "lucide-react";
import { memo } from "react";
import {
  type AgentConfigurationData,
  AgentConfigurationForm,
} from "@/components/agents/AgentConfigurationForm";

// Re-export the type for convenience
export type { AgentConfigurationData as AgentSettingsData };

interface AgentSettingsStepProps {
  settings: AgentConfigurationData;
  onSettingsChange: (settings: AgentConfigurationData) => void;
}

export const AgentSettingsStep = memo(function AgentSettingsStep({
  settings,
  onSettingsChange,
}: AgentSettingsStepProps) {
  return (
    <div className="space-y-6">
      {/* Info Banner */}
      <div className="flex items-start gap-3 rounded-lg border border-[#0066FF]/20 bg-[#0066FF]/5 p-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#0066FF]" />
        <div>
          <p className="font-medium text-sm">
            Configure your agent's capabilities
          </p>
          <p className="mt-1 text-muted-foreground text-sm">
            You can change these settings anytime from your agent's settings
            page.
          </p>
        </div>
      </div>

      {/* Shared Configuration Form */}
      <AgentConfigurationForm data={settings} onChange={onSettingsChange} />
    </div>
  );
});
