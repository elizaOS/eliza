/**
 * Global coding-agent preference controls in the settings panel: the default
 * coding directory, the agent selection strategy, the approval preset, and the
 * multi-account strategy.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
  useAppSelector,
} from "@elizaos/ui";
import { useState } from "react";
import {
  type AgentSelectionStrategy,
  APPROVAL_PRESETS,
  type ApprovalPreset,
  CODING_ACCOUNT_STRATEGY_OPTIONS,
  type CodingAccountStrategy,
  isCodingAccountStrategy,
} from "./coding-agent-settings-shared";

function CodingDirInput({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (val: string) => void;
}) {
  const [val, setVal] = useState(initial);
  return (
    <SettingsControls.Input
      className="w-full"
      variant="compact"
      type="text"
      placeholder="~/Projects"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => onCommit(val)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(val);
      }}
    />
  );
}

interface GlobalPrefsSectionProps {
  prefs: Record<string, string>;
  selectionStrategy: AgentSelectionStrategy;
  approvalPreset: ApprovalPreset;
  setPref: (key: string, value: string) => void;
}

export function GlobalPrefsSection({
  prefs,
  selectionStrategy,
  approvalPreset,
  setPref,
}: GlobalPrefsSectionProps) {
  const t = useAppSelector((s) => s.t);
  const accountStrategy: CodingAccountStrategy = isCodingAccountStrategy(
    prefs.ELIZA_CODING_ACCOUNT_STRATEGY,
  )
    ? prefs.ELIZA_CODING_ACCOUNT_STRATEGY
    : "least-used";

  return (
    <>
      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.AgentSelectionStra")}
        </SettingsControls.FieldLabel>
        <Select
          value={selectionStrategy}
          onValueChange={(value: string) =>
            setPref("ELIZA_AGENT_SELECTION_STRATEGY", value)
          }
        >
          <SettingsControls.SelectTrigger variant="compact">
            <SelectValue />
          </SettingsControls.SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">
              {t("codingagentsettingssection.Fixed")}
            </SelectItem>
            <SelectItem value="ranked">
              {t("codingagentsettingssection.RankedAutoSelect")}
            </SelectItem>
          </SelectContent>
        </Select>
        <SettingsControls.FieldDescription className="sr-only">
          {selectionStrategy === "fixed"
            ? t("codingagentsettingssection.AgentUsedWhenNoEStrategyFixed")
            : t("codingagentsettingssection.AgentUsedWhenNoEStrategyRanked")}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>

      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.AccountPoolStrategy", {
            defaultValue: "Account Pool Strategy",
          })}
        </SettingsControls.FieldLabel>
        <Select
          value={accountStrategy}
          onValueChange={(value: string) => {
            if (isCodingAccountStrategy(value)) {
              setPref("ELIZA_CODING_ACCOUNT_STRATEGY", value);
            }
          }}
        >
          <SettingsControls.SelectTrigger variant="compact">
            <SelectValue />
          </SettingsControls.SelectTrigger>
          <SelectContent>
            {CODING_ACCOUNT_STRATEGY_OPTIONS.map((strategy) => (
              <SelectItem key={strategy.value} value={strategy.value}>
                {t(strategy.labelKey, {
                  defaultValue: strategy.defaultLabel,
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SettingsControls.FieldDescription className="sr-only">
          {t("codingagentsettingssection.AccountPoolStrategyDesc", {
            defaultValue:
              "How to select between multiple accounts for the same coding agent. This sets ELIZA_CODING_ACCOUNT_STRATEGY for spawned agents.",
          })}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>

      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.DefaultPermissionL")}
        </SettingsControls.FieldLabel>
        <Select
          value={approvalPreset}
          onValueChange={(value: string) =>
            setPref("ELIZA_DEFAULT_APPROVAL_PRESET", value)
          }
        >
          <SettingsControls.SelectTrigger variant="compact">
            <SelectValue />
          </SettingsControls.SelectTrigger>
          <SelectContent>
            {APPROVAL_PRESETS.map((preset) => (
              <SelectItem key={preset.value} value={preset.value}>
                {t(preset.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SettingsControls.FieldDescription className="sr-only">
          {APPROVAL_PRESETS.find((preset) => preset.value === approvalPreset)
            ?.descKey
            ? t(
                APPROVAL_PRESETS.find(
                  (preset) => preset.value === approvalPreset,
                )?.descKey ?? "",
              )
            : ""}
          {t("codingagentsettingssection.AppliesToAllNewlySpawned")}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>

      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.ScratchRetention", {
            defaultValue: "Scratch Retention",
          })}
        </SettingsControls.FieldLabel>
        <Select
          value={prefs.ELIZA_SCRATCH_RETENTION || "pending_decision"}
          onValueChange={(value: string) => {
            if (!prefs.ELIZA_SCRATCH_RETENTION && value === "pending_decision")
              return;
            setPref("ELIZA_SCRATCH_RETENTION", value);
          }}
        >
          <SettingsControls.SelectTrigger variant="compact">
            <SelectValue />
          </SettingsControls.SelectTrigger>
          <SelectContent>
            <SelectItem value="ephemeral">
              {t("codingagentsettingssection.RetentionEphemeral", {
                defaultValue: "Auto-delete",
              })}
            </SelectItem>
            <SelectItem value="pending_decision">
              {t("codingagentsettingssection.RetentionAskMe", {
                defaultValue: "Ask me (default)",
              })}
            </SelectItem>
            <SelectItem value="persistent">
              {t("codingagentsettingssection.RetentionAlwaysKeep", {
                defaultValue: "Always keep",
              })}
            </SelectItem>
          </SelectContent>
        </Select>
        <SettingsControls.FieldDescription className="sr-only">
          {t("codingagentsettingssection.ScratchRetentionDesc", {
            defaultValue:
              "What happens to scratch workspace code when a task finishes.",
          })}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>

      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.CodingDirectory", {
            defaultValue: "Coding Directory",
          })}
        </SettingsControls.FieldLabel>
        <CodingDirInput
          initial={prefs.ELIZA_CODING_DIRECTORY || ""}
          onCommit={(val) => setPref("ELIZA_CODING_DIRECTORY", val)}
        />
        <SettingsControls.FieldDescription className="sr-only">
          {t("codingagentsettingssection.CodingDirectoryDesc", {
            defaultValue:
              "Where scratch task code is saved. Leave empty for default (~/.eliza/workspaces/).",
          })}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>
    </>
  );
}
