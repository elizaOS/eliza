/**
 * Explicit Google Workspace capability picker for connector OAuth starts.
 * The selected capability ids are sent as `scopes` on the OAuth start request.
 */

import { useMemo } from "react";
import { cn } from "../../lib/utils";
import { useTranslation } from "../../state/TranslationContext.hooks";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";
import {
  GOOGLE_WORKSPACE_CAPABILITY_GROUPS,
  GOOGLE_WORKSPACE_CAPABILITY_OPTIONS,
  type GoogleWorkspaceCapabilityGroup,
  type GoogleWorkspaceCapabilityId,
  googleWorkspaceCapabilityGroupLabel,
} from "./google-workspace-capabilities";

export interface GoogleWorkspaceCapabilityPickerProps {
  selected: readonly GoogleWorkspaceCapabilityId[];
  onChange: (next: GoogleWorkspaceCapabilityId[]) => void;
  className?: string;
  disabled?: boolean;
}

export function GoogleWorkspaceCapabilityPicker({
  selected,
  onChange,
  className,
  disabled = false,
}: GoogleWorkspaceCapabilityPickerProps) {
  const { t } = useTranslation();
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const grouped = useMemo(() => {
    const buckets = new Map<
      GoogleWorkspaceCapabilityGroup,
      typeof GOOGLE_WORKSPACE_CAPABILITY_OPTIONS
    >();
    for (const group of GOOGLE_WORKSPACE_CAPABILITY_GROUPS) {
      buckets.set(
        group,
        GOOGLE_WORKSPACE_CAPABILITY_OPTIONS.filter(
          (option) => option.group === group,
        ),
      );
    }
    return buckets;
  }, []);

  const toggle = (
    capabilityId: GoogleWorkspaceCapabilityId,
    checked: boolean,
  ) => {
    if (disabled) return;
    const next = new Set(selectedSet);
    if (checked) next.add(capabilityId);
    else next.delete(capabilityId);
    onChange([...next]);
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-sm border border-border/40 bg-card/20 p-3",
        className,
      )}
    >
      <div className="space-y-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {t("connectors.google.capabilities.title", {
            defaultValue: "Requested capabilities",
          })}
        </h3>
        <p className="text-xs text-muted">
          {t("connectors.google.capabilities.description", {
            defaultValue:
              "Choose the Google products this connection may access. At least one capability is required before starting OAuth.",
          })}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {GOOGLE_WORKSPACE_CAPABILITY_GROUPS.map((group) => {
          const options = grouped.get(group) ?? [];
          return (
            <section
              key={group}
              className="rounded-sm border border-border/35 bg-bg-accent/30 p-3"
              aria-label={googleWorkspaceCapabilityGroupLabel(group)}
            >
              <h4 className="mb-2 text-xs font-semibold text-foreground">
                {googleWorkspaceCapabilityGroupLabel(group)}
              </h4>
              <ul className="flex flex-col gap-2">
                {options.map((option) => {
                  const inputId = `google-capability-${option.id}`;
                  const checked = selectedSet.has(option.id);
                  return (
                    <li key={option.id}>
                      <div className="flex items-start gap-2">
                        <Checkbox
                          id={inputId}
                          checked={checked}
                          disabled={disabled}
                          onCheckedChange={(value) =>
                            toggle(option.id, value === true)
                          }
                        />
                        <div className="space-y-0.5">
                          <Label
                            htmlFor={inputId}
                            className="text-xs font-medium leading-none"
                          >
                            {option.label}
                          </Label>
                          <p className="text-[11px] leading-snug text-muted">
                            {option.description}
                          </p>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      {selected.length === 0 ? (
        <p className="text-xs text-destructive">
          {t("connectors.google.capabilities.required", {
            defaultValue:
              "Select at least one Gmail, Calendar, Drive, or Meet capability.",
          })}
        </p>
      ) : null}
    </div>
  );
}
