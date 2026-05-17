import type { ComponentType } from "react";
export type ProviderStatusTone = "ok" | "warn" | "muted";
export type ProviderCategory = "cloud" | "subscription" | "key" | "local";
export interface ProviderStatus {
    tone: ProviderStatusTone;
    label: string;
}
export interface ProviderCardProps {
    id: string;
    icon: ComponentType<{
        className?: string;
        "aria-hidden"?: boolean;
    }>;
    label: string;
    category: ProviderCategory;
    status: ProviderStatus;
    current: boolean;
    selected: boolean;
    onSelect: (id: string) => void;
}
export declare function ProviderCard({ id, icon: Icon, label, category, status, current, selected, onSelect, }: ProviderCardProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ProviderCard.d.ts.map