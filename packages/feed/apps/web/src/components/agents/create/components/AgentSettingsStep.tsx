"use client";

import { Info } from "lucide-react";
import Link from "next/link";
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
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-muted-foreground text-xs">
        <Info className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p>
          <Link
            href="/research"
            className="font-medium text-primary underline underline-offset-2 hover:text-primary/90"
          >
            Bring your own model. Train it in Feed.
          </Link>
        </p>
      </div>

      <AgentConfigurationForm data={settings} onChange={onSettingsChange} />
    </div>
  );
});
