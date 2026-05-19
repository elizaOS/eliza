export interface EditableAccountLabelProps {
    value: string;
    onSubmit: (label: string) => Promise<void> | void;
    disabled?: boolean;
    inputAriaLabel?: string;
    editTitle?: string;
    className?: string;
    inputClassName?: string;
}
export declare function EditableAccountLabel({ value, onSubmit, disabled, inputAriaLabel, editTitle, className, inputClassName, }: EditableAccountLabelProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=EditableAccountLabel.d.ts.map