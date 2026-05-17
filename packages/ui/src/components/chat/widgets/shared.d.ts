import type { ReactNode } from "react";
export declare function WidgetSection({ title, icon, action, children, testId, onTitleClick, }: {
    title: string;
    icon: ReactNode;
    action?: ReactNode;
    children: ReactNode;
    testId: string;
    /** When set, the title area becomes a button navigating elsewhere. */
    onTitleClick?: () => void;
}): import("react/jsx-runtime").JSX.Element;
export declare function EmptyWidgetState({ icon, title, description, children, }: {
    icon: ReactNode;
    title: string;
    description?: string;
    children?: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=shared.d.ts.map