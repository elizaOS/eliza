import { useApp } from "@elizaos/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectValue,
  SettingsControls,
} from "@elizaos/ui";
import { useState } from "react";
import {
  type AgentSelectionStrategy,
  APPROVAL_PRESETS,
  type ApprovalPreset,
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
  const { t } = useApp();
  return (
    <>
      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.AgentSelectionStra")}
        </SettingsControls.FieldLabel>
        <Select
          value={selectionStrategy}
          onValueChange={(value: string) =>
            setPref("PARALLAX_AGENT_SELECTION_STRATEGY", value)
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
        <SettingsControls.FieldDescription className="mt-1.5">
          {selectionStrategy === "fixed"
            ? t("codingagentsettingssection.AgentUsedWhenNoEStrategyFixed")
            : t("codingagentsettingssection.AgentUsedWhenNoEStrategyRanked")}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>

      <SettingsControls.Field>
        <SettingsControls.FieldLabel>
          {t("codingagentsettingssection.DefaultPermissionL")}
        </SettingsControls.FieldLabel>
        <Select
          value={approvalPreset}
          onValueChange={(value: string) =>
            setPref("PARALLAX_DEFAULT_APPROVAL_PRESET", value)
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
        <SettingsControls.FieldDescription className="mt-1.5">
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
          value={prefs.PARALLAX_SCRATCH_RETENTION || "pending_decision"}
          onValueChange={(value: string) => {
            if (
              !prefs.PARALLAX_SCRATCH_RETENTION &&
              value === "pending_decision"
            )
              return;
            setPref("PARALLAX_SCRATCH_RETENTION", value);
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
        <SettingsControls.FieldDescription>
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
          initial={prefs.PARALLAX_CODING_DIRECTORY || ""}
          onCommit={(val) => setPref("PARALLAX_CODING_DIRECTORY", val)}
        />
        <SettingsControls.FieldDescription>
          {t("codingagentsettingssection.CodingDirectoryDesc", {
            defaultValue:
              "Where scratch task code is saved. Leave empty for default (~/.eliza/workspaces/).",
          })}
        </SettingsControls.FieldDescription>
      </SettingsControls.Field>
    </>
  );
}
