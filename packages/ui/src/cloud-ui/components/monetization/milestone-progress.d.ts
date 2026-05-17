/**
 * Milestone progress component showing progress toward withdrawal threshold.
 * Features animated progress bar and celebratory state when milestone is reached.
 */
interface MilestoneProgressProps {
    current: number;
    target: number;
    label?: string;
    className?: string;
    showAmount?: boolean;
}
export declare function MilestoneProgress({ current, target, label, className, showAmount, }: MilestoneProgressProps): import("react/jsx-runtime").JSX.Element;
interface MilestoneCardProps extends MilestoneProgressProps {
    title?: string;
}
export declare function MilestoneCard({ title, ...props }: MilestoneCardProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=milestone-progress.d.ts.map