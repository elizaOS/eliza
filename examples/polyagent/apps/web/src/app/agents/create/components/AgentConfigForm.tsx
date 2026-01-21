"use client";

import { cn } from "@polyagent/shared";
import { Loader2, Sparkles } from "lucide-react";
import { memo } from "react";
import type { AgentFormData } from "../hooks/useAgentForm";

interface AgentConfigFormProps {
  agentData: AgentFormData;
  generatingField: string | null;
  maxDeposit: number;
  onFieldChange: (field: keyof AgentFormData, value: string | number) => void;
  onRegenerate: (field: string) => void;
}

interface FieldWithAIProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  rows?: number;
  isGenerating: boolean;
  onRegenerate: () => void;
  onChange: (value: string) => void;
  helpText?: string;
}

const FieldWithAI = memo(function FieldWithAI({
  id,
  label,
  value,
  placeholder,
  rows = 4,
  isGenerating,
  onRegenerate,
  onChange,
  helpText,
}: FieldWithAIProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="font-medium text-sm">
          {label}
        </label>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={isGenerating}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors",
            "text-muted-foreground hover:bg-muted hover:text-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isGenerating ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="h-3 w-3" />
              Regenerate
            </>
          )}
        </button>
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={cn(
          "w-full resize-none rounded-lg border border-border bg-muted px-4 py-3 font-mono text-sm",
          "focus:outline-none focus:ring-2 focus:ring-[#0066FF]",
          isGenerating && "animate-pulse opacity-70",
        )}
      />
      {helpText && <p className="text-muted-foreground text-xs">{helpText}</p>}
    </div>
  );
});

export const AgentConfigForm = memo(function AgentConfigForm({
  agentData,
  generatingField,
  maxDeposit,
  onFieldChange,
  onRegenerate,
}: AgentConfigFormProps) {
  return (
    <div className="space-y-6">
      <FieldWithAI
        id="system"
        label="System Prompt"
        value={agentData.system}
        placeholder="You are a trading agent focused on..."
        rows={6}
        isGenerating={generatingField === "system"}
        onRegenerate={() => onRegenerate("system")}
        onChange={(v) => onFieldChange("system", v)}
        helpText="Core instructions defining agent behavior and capabilities."
      />

      <FieldWithAI
        id="personality"
        label="Personality"
        value={agentData.personality}
        placeholder="Analytical and methodical..."
        rows={4}
        isGenerating={generatingField === "personality"}
        onRegenerate={() => onRegenerate("personality")}
        onChange={(v) => onFieldChange("personality", v)}
        helpText="Character traits that influence communication style."
      />

      <FieldWithAI
        id="tradingStrategy"
        label="Trading Strategy"
        value={agentData.tradingStrategy}
        placeholder="Focus on momentum indicators..."
        rows={5}
        isGenerating={generatingField === "tradingStrategy"}
        onRegenerate={() => onRegenerate("tradingStrategy")}
        onChange={(v) => onFieldChange("tradingStrategy", v)}
        helpText="Market analysis approach and position sizing rules."
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="initialDeposit" className="font-medium text-sm">
            Initial Deposit
          </label>
          <span className="font-mono text-muted-foreground text-sm">
            {agentData.initialDeposit.toLocaleString()} points
          </span>
        </div>
        <input
          id="initialDeposit"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={agentData.initialDeposit === 0 ? "" : agentData.initialDeposit}
          onChange={(e) => {
            // Allow free typing - accept empty or numeric values
            const rawValue = e.target.value.replace(/[^0-9]/g, "");
            if (rawValue === "") {
              onFieldChange("initialDeposit", 0);
            } else {
              onFieldChange("initialDeposit", parseInt(rawValue, 10));
            }
          }}
          onBlur={() => {
            // On blur, clamp to valid range
            const val = agentData.initialDeposit;
            if (val < 10) {
              onFieldChange("initialDeposit", 10);
            } else if (val > maxDeposit) {
              onFieldChange("initialDeposit", maxDeposit);
            }
          }}
          className={cn(
            "w-full rounded-lg border border-border bg-muted px-4 py-3 font-mono text-sm",
            "focus:outline-none focus:ring-2 focus:ring-[#0066FF]",
          )}
        />
        <p className="text-muted-foreground text-xs">
          Points to fund your agent&apos;s trading account (10 -{" "}
          {maxDeposit.toLocaleString()}). You can add more later.
        </p>
      </div>
    </div>
  );
});
