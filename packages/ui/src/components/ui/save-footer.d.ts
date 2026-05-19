import * as React from "react";
export interface SaveFooterProps extends React.HTMLAttributes<HTMLDivElement> {
    dirty: boolean;
    saving: boolean;
    saveError: string | null;
    saveSuccess: boolean;
    onSave: () => void;
    saveLabel?: string;
    savingLabel?: string;
    savedLabel?: string;
}
export declare const SaveFooter: React.ForwardRefExoticComponent<SaveFooterProps & React.RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=save-footer.d.ts.map