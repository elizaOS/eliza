import { useCallback, useState } from "react";
import { client } from "../../api";
import type {
  AgentModelSlot,
  InstalledModel,
  ModelAssignments,
} from "../../api/client-local-inference";

interface SlotAssignmentsProps {
  installed: InstalledModel[];
  assignments: ModelAssignments;
  onChange: (assignments: ModelAssignments) => void;
}

const SLOTS: Array<{ slot: AgentModelSlot; label: string; description: string }> = [
  {
    slot: "TEXT_SMALL",
    label: "Small model (TEXT_SMALL)",
    description:
      "Fast model used for short completions, classifications, and background tasks.",
  },
  {
    slot: "TEXT_LARGE",
    label: "Large model (TEXT_LARGE)",
    description:
      "Main model used for the agent's chat responses and reasoning.",
  },
  {
    slot: "TEXT_EMBEDDING",
    label: "Embedding model (TEXT_EMBEDDING)",
    description: "Vector embeddings for search and memory. Separate model.",
  },
  {
    slot: "OBJECT_SMALL",
    label: "Small structured output (OBJECT_SMALL)",
    description: "XML/JSON structured generation on the small path.",
  },
  {
    slot: "OBJECT_LARGE",
    label: "Large structured output (OBJECT_LARGE)",
    description: "Structured generation on the large path.",
  },
];

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
  const [busySlot, setBusySlot] = useState<AgentModelSlot | null>(null);

  const handleChange = useCallback(
    async (slot: AgentModelSlot, modelId: string | null) => {
      setBusySlot(slot);
      try {
        const response = await client.setLocalInferenceAssignment(
          slot,
          modelId,
        );
        onChange(response.assignments);
      } finally {
        setBusySlot(null);
      }
    },
    [onChange],
  );

  if (installed.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        Download or scan at least one model to assign it to agent slots.
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Agent model assignments
      </h3>
      <p className="text-xs text-muted-foreground">
        Route each of the agent's model calls to a specific local model.
        Changes apply on the next request — the runtime lazy-loads the
        assigned model on demand and swaps when needed.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {SLOTS.map(({ slot, label, description }) => {
          const currentId = assignments[slot] ?? "";
          return (
            <label
              key={slot}
              className="rounded-xl border border-border bg-card p-3 flex flex-col gap-1.5"
            >
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">
                {description}
              </span>
              <select
                value={currentId}
                disabled={busySlot === slot}
                onChange={(e) =>
                  void handleChange(slot, e.target.value || null)
                }
                className="mt-1 rounded-md border border-border bg-bg/50 px-2 py-1.5 text-sm"
              >
                <option value="">— unset (use active model) —</option>
                {installed.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                    {m.source === "external-scan"
                      ? ` · via ${m.externalOrigin}`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}
