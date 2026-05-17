import type { InstalledModel, ModelAssignments } from "../../api/client-local-inference";
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
export declare function SlotAssignments({ installed, assignments, onChange, }: SlotAssignmentsProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=SlotAssignments.d.ts.map