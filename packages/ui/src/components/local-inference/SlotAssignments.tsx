import { useCallback, useRef, useState } from "react";
import { client } from "../../api";
import type {
  AgentModelSlot,
  InstalledModel,
  ModelAssignments,
} from "../../api/client-local-inference";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import { useRenderGuard } from "../../hooks/useRenderGuard";
import { isVerifiedCuratedEliza1Download } from "../../services/local-inference/catalog-policy";
import { useTranslation } from "../../state/TranslationContext.hooks";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  installedRuntimeClass,
  runtimeClassBadge,
  runtimeClassDescription,
  runtimeClassUnavailableReason,
} from "./runtime-class-ui";
import { LOCAL_INFERENCE_SLOT_DESCRIPTORS } from "./slot-metadata";

const AUTO_ASSIGNMENT_VALUE = "__auto__";

interface SlotAssignmentsProps {
  installed: InstalledModel[];
  assignments: ModelAssignments;
  onChange: (assignments: ModelAssignments) => void;
}

/**
 * Per-ModelType slot assignment UI. Renders one dropdown per agent model
 * slot; selecting a model writes the assignment to disk immediately.
 * Slots with no assignment fall through to the legacy "active model"
 * behaviour (use whatever is currently loaded).
 */
export function SlotAssignments({
  installed,
  assignments,
  onChange,
}: SlotAssignmentsProps) {
  useRenderGuard("SlotAssignments");
  const { t } = useTranslation();
  const branding = useBranding();
  const requestSeqRef = useRef(new Map<AgentModelSlot, number>());
  const [busySlots, setBusySlots] = useState<Set<AgentModelSlot>>(
    () => new Set(),
  );
  const [slotErrors, setSlotErrors] = useState<
    Partial<Record<AgentModelSlot, string>>
  >({});

  const setSlotBusy = useCallback((slot: AgentModelSlot, busy: boolean) => {
    setBusySlots((prev) => {
      const next = new Set(prev);
      if (busy) {
        next.add(slot);
      } else {
        next.delete(slot);
      }
      return next;
    });
  }, []);

  const handleChange = useCallback(
    async (slot: AgentModelSlot, modelId: string | null) => {
      const requestId = (requestSeqRef.current.get(slot) ?? 0) + 1;
      requestSeqRef.current.set(slot, requestId);
      setSlotBusy(slot, true);
      setSlotErrors((prev) => ({ ...prev, [slot]: undefined }));
      try {
        const response = await client.setLocalInferenceAssignment(
          slot,
          modelId,
        );
        if (requestSeqRef.current.get(slot) === requestId) {
          onChange(response.assignments);
        }
      } catch (err) {
        // The server rejects a pick the platform's engine can't serve with a
        // typed reason (422). Surface it inline instead of a silent no-op.
        if (requestSeqRef.current.get(slot) === requestId) {
          setSlotErrors((prev) => ({
            ...prev,
            [slot]: err instanceof Error ? err.message : String(err),
          }));
        }
      } finally {
        if (requestSeqRef.current.get(slot) === requestId) {
          setSlotBusy(slot, false);
        }
      }
    },
    [onChange, setSlotBusy],
  );

  const assignableInstalled = installed.filter(isVerifiedCuratedEliza1Download);

  if (assignableInstalled.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-border p-4 text-sm text-muted-foreground">
        {t("slotassignments.empty", {
          defaultValue:
            "Download Eliza-1 to enable local inference. Local setup no longer uses scanned or custom GGUFs.",
        })}
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t("slotassignments.title", {
          defaultValue: "Managed Eliza-1 routing",
        })}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t("slotassignments.description", {
          defaultValue:
            "{{appName}} keeps every local slot on the selected Eliza-1 bundle so setup stays one-click and the FFI runtime controls memory.",
          ...appNameInterpolationVars(branding),
        })}
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {LOCAL_INFERENCE_SLOT_DESCRIPTORS.map(
          ({ slot, label, description }) => {
            const currentId = assignments[slot] ?? "";
            const selected = assignableInstalled.find(
              (m) => m.id === currentId,
            );
            const selectedRuntimeClass = selected
              ? installedRuntimeClass(selected)
              : null;
            const selectedUnavailableReason = selectedRuntimeClass
              ? runtimeClassUnavailableReason(selectedRuntimeClass)
              : null;
            return (
              <div
                key={slot}
                className="rounded-sm border border-border bg-card p-3 flex flex-col gap-1.5"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {label}
                  {selectedRuntimeClass ? (
                    <span
                      className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] font-normal leading-none text-muted-foreground"
                      title={runtimeClassDescription(selectedRuntimeClass)}
                    >
                      {runtimeClassBadge(selectedRuntimeClass)}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {description}
                </span>
                <Select
                  value={currentId || AUTO_ASSIGNMENT_VALUE}
                  disabled={busySlots.has(slot)}
                  onValueChange={(value) =>
                    void handleChange(
                      slot,
                      value === AUTO_ASSIGNMENT_VALUE ? null : value,
                    )
                  }
                >
                  <SelectTrigger
                    aria-label={label}
                    className="mt-1 h-9 border-border bg-bg/50 text-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_ASSIGNMENT_VALUE}>
                      {t("slotassignments.auto", { defaultValue: "Auto" })}
                    </SelectItem>
                    {assignableInstalled.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.displayName} ·{" "}
                        {runtimeClassBadge(installedRuntimeClass(m))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedUnavailableReason ? (
                  <span className="text-xs text-warn">
                    {selectedUnavailableReason}
                  </span>
                ) : null}
                {slotErrors[slot] ? (
                  <span className="text-xs text-danger">
                    {slotErrors[slot]}
                  </span>
                ) : null}
              </div>
            );
          },
        )}
      </div>
    </section>
  );
}
