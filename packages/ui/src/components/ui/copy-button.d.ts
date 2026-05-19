import * as React from "react";
export interface CopyButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
    /** Text to copy to clipboard */
    value: string;
    /** Duration of the "copied" feedback in ms */
    feedbackDuration?: number;
    /** Aria-label for default state */
    copyLabel?: string;
    /** Aria-label for copied state */
    copiedLabel?: string;
}
export declare const CopyButton: React.ForwardRefExoticComponent<CopyButtonProps & React.RefAttributes<HTMLButtonElement>>;
//# sourceMappingURL=copy-button.d.ts.map