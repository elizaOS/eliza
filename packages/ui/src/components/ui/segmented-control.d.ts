import type * as React from "react";
export interface SegmentedControlItem<T extends string> {
    value: T;
    label: React.ReactNode;
    badge?: React.ReactNode;
    disabled?: boolean;
    testId?: string;
}
export interface SegmentedControlProps<T extends string> extends React.HTMLAttributes<HTMLDivElement> {
    value: T;
    onValueChange: (value: T) => void;
    items: Array<SegmentedControlItem<T>>;
    buttonClassName?: string;
    activeButtonClassName?: string;
    inactiveButtonClassName?: string;
}
export declare function SegmentedControl<T extends string>({ value, onValueChange, items, className, buttonClassName, activeButtonClassName, inactiveButtonClassName, ...props }: SegmentedControlProps<T>): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=segmented-control.d.ts.map