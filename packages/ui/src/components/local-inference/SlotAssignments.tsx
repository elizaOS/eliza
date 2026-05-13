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

const SLOTS: Array<{
  slot: AgentModelSlot;
  label: string;
  description: string;
}> = [
  {
    slot: "TEXT_SMALL",
    label: "Small text",
    description: "Short completions, classifications, and background requests.",
  },
  {
    slot: "TEXT_LARGE",
    label: "Large text",
    description: "Main chat responses, planning, and reasoning.",
  },
  {
    slot: "TEXT_EMBEDDING",
    label: "Embeddings",
    description:
      "Vector search and memory when a local embedding handler exists.",
  },
  {
    slot: "TEXT_TO_SPEECH",
    label: "Voice output",
    description: "Local Eliza-1 TTS for agent speech and voice mode replies.",
  },
  {
    slot: "TRANSCRIPTION",
    label: "Transcription",
    description: "Local Eliza-1 ASR for microphone and voice message input.",
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
        Download or scan at least one model to use local inference.
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Local model assignments
      </h3>
      <p className="text-xs text-muted-foreground">
        Eliza defaults both text routes to the largest installed local model so
        only one model has to stay in memory. Override a slot only when you
        explicitly want a different local model.
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
                <option value="">Auto</option>
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
