import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import type { PagePanelVariant } from "./page-panel-types";
export interface PagePanelFeatureEmptyItem {
    id: string;
    label: ReactNode;
    icon: ComponentType<{
        className?: string;
    }>;
    tone?: string;
}
export interface PagePanelFeatureEmptyProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
    title: ReactNode;
    description?: ReactNode;
    icon: ComponentType<{
        className?: string;
    }>;
    iconTone?: string;
    features?: ReadonlyArray<PagePanelFeatureEmptyItem>;
    variant?: Extract<PagePanelVariant, "surface" | "section" | "inset">;
}
export declare function PagePanelFeatureEmpty({ className, description, features, icon: Icon, iconTone, title, variant, ...props }: PagePanelFeatureEmptyProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=page-panel-feature-empty.d.ts.map