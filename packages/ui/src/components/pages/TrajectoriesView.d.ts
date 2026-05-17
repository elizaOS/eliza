import { type ReactNode } from "react";
interface TrajectoriesViewProps {
    contentHeader?: ReactNode;
    selectedTrajectoryId?: string | null;
    onSelectTrajectory?: (id: string | null) => void;
}
export declare function TrajectoriesView({ contentHeader, selectedTrajectoryId: controlledId, onSelectTrajectory: controlledOnSelect, }: TrajectoriesViewProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=TrajectoriesView.d.ts.map