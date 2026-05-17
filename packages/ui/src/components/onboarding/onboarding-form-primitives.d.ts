import type * as React from "react";
export declare const onboardingDetailStackClassName = "flex w-full flex-col gap-4 text-left";
export declare const onboardingReadableTextStrongClassName = "text-[var(--onboarding-text-strong)] [text-shadow:var(--onboarding-text-shadow-strong)] [-webkit-text-stroke:0.3px_var(--onboarding-text-stroke)]";
export declare const onboardingReadableTextPrimaryClassName = "text-[var(--onboarding-text-primary)] [text-shadow:var(--onboarding-text-shadow-primary)]";
export declare const onboardingReadableTextMutedClassName = "text-[var(--onboarding-text-muted)] [text-shadow:var(--onboarding-text-shadow-muted)]";
export declare const onboardingReadableTextSubtleClassName = "text-[var(--onboarding-text-subtle)] [text-shadow:var(--onboarding-text-shadow-muted)]";
export declare const onboardingReadableTextFaintClassName = "text-[var(--onboarding-text-faint)] [text-shadow:var(--onboarding-text-shadow-muted)]";
export declare const onboardingHelperTextClassName = "text-xs leading-relaxed text-[var(--onboarding-text-muted)] [text-shadow:var(--onboarding-text-shadow-muted)]";
export declare const onboardingTextSupportClassName = "rounded-sm bg-[var(--onboarding-text-support-bg)] px-3 py-2 my-2 shadow-sm";
export declare const onboardingInputClassName = "h-12 w-full rounded-sm px-4 text-left text-[var(--onboarding-text-primary)] [text-shadow:var(--onboarding-text-shadow-primary)] transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-[var(--onboarding-text-subtle)] focus-visible:border-[var(--onboarding-field-focus-border)] focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:shadow-[var(--onboarding-field-focus-shadow)] border border-[var(--onboarding-input-border)] bg-[var(--onboarding-input-bg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]";
interface OnboardingFieldProps {
    align?: "left" | "center";
    children: (controlProps: {
        describedBy?: string;
        invalid: boolean;
    }) => React.ReactNode;
    className?: string;
    controlId?: string;
    description?: React.ReactNode;
    descriptionClassName?: string;
    label?: React.ReactNode;
    labelClassName?: string;
    message?: React.ReactNode;
    messageClassName?: string;
    messageTone?: "default" | "danger" | "success";
}
export declare function OnboardingField({ align, children, className, controlId, description, descriptionClassName, label, labelClassName, message, messageClassName, messageTone, }: OnboardingFieldProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=onboarding-form-primitives.d.ts.map