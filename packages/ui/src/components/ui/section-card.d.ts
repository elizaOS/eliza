import * as React from "react";
export interface SectionCardProps extends React.HTMLAttributes<HTMLDivElement> {
    /** Section title shown in the header */
    title?: string;
    /** Optional description below the title */
    description?: string;
    /** Optional actions (buttons, badges) aligned to the right of the header */
    actions?: React.ReactNode;
    /** Whether the section is collapsible */
    collapsible?: boolean;
    /** Default collapsed state (only when collapsible) */
    defaultCollapsed?: boolean;
}
export declare const SectionCard: React.ForwardRefExoticComponent<SectionCardProps & React.RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=section-card.d.ts.map