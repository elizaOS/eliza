import { type ReactNode } from "react";
export type CalloutType = "info" | "warning" | "error" | "default";
export declare function Callout({ type, emoji, children, }: {
    type?: CalloutType;
    emoji?: ReactNode;
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
declare function CardsCard({ title, href, icon, children, }: {
    title: string;
    href: string;
    icon?: ReactNode;
    children?: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function Cards({ children }: {
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare namespace Cards {
    var Card: typeof CardsCard;
}
export declare function Steps({ children }: {
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
declare function TabsTab({ children }: {
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare function Tabs({ items, children, }: {
    items: ReactNode[];
    children: ReactNode;
}): import("react/jsx-runtime").JSX.Element;
export declare namespace Tabs {
    var Tab: typeof TabsTab;
}
export {};
//# sourceMappingURL=mdx-components.d.ts.map