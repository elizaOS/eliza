export type ConfirmVariant = "danger" | "warn" | "default";
export interface ConfirmDialogProps {
    open: boolean;
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: ConfirmVariant;
    onConfirm: () => void;
    onCancel: () => void;
}
export declare function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, variant: variantProp, onConfirm, onCancel, }: ConfirmDialogProps): import("react/jsx-runtime").JSX.Element;
export interface PromptDialogProps {
    open: boolean;
    title?: string;
    message: string;
    placeholder?: string;
    defaultValue?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: (value: string) => void;
    onCancel: () => void;
}
export declare function PromptDialog({ open, title, message, placeholder, defaultValue, confirmLabel, cancelLabel, onConfirm, onCancel, }: PromptDialogProps): import("react/jsx-runtime").JSX.Element;
export interface ConfirmOptions {
    title?: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: ConfirmVariant;
}
export declare function useConfirm(): {
    confirm: (opts: ConfirmOptions) => Promise<boolean>;
    modalProps: ConfirmDialogProps;
};
export interface PromptOptions {
    title?: string;
    message: string;
    placeholder?: string;
    defaultValue?: string;
    confirmLabel?: string;
    cancelLabel?: string;
}
export declare function usePrompt(): {
    prompt: (opts: PromptOptions) => Promise<string | null>;
    modalProps: PromptDialogProps;
};
//# sourceMappingURL=confirm-dialog.d.ts.map