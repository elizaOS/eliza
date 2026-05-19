import type * as React from "react";
export interface SkillSidebarItemProps {
    active?: boolean;
    attentionLabel?: React.ReactNode;
    description?: React.ReactNode;
    enabled: boolean;
    icon?: React.ReactNode;
    name: React.ReactNode;
    offLabel: React.ReactNode;
    onLabel: React.ReactNode;
    onSelect?: () => void;
    testId?: string;
    buttonProps?: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick" | "type">;
}
export declare function SkillSidebarItem({ active, attentionLabel, description, enabled, icon, name, offLabel, onLabel, onSelect, testId, buttonProps, }: SkillSidebarItemProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=skill-sidebar-item.d.ts.map