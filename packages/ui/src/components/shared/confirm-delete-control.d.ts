import { type ReactNode } from "react";
type ConfirmDeleteControlProps = {
    onConfirm: () => void;
    disabled?: boolean;
    triggerLabel?: string | ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    busyLabel?: string;
    promptText?: string;
    triggerClassName: string;
    confirmClassName: string;
    cancelClassName: string;
    promptClassName?: string;
    triggerTitle?: string;
    triggerVariant?: "destructive" | "outline" | "ghost";
};
export declare function ConfirmDeleteControl({ onConfirm, disabled, triggerLabel, confirmLabel, cancelLabel, busyLabel, promptText, triggerClassName, confirmClassName, cancelClassName, promptClassName, triggerTitle, triggerVariant, }: ConfirmDeleteControlProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=confirm-delete-control.d.ts.map