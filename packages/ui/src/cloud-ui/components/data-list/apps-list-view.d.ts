import type { ReactNode } from "react";
export interface AppsListItem {
    id: string;
    name: string;
    app_url: string;
    website_url?: string | null;
    is_active: boolean;
    affiliate_code?: string | null;
    total_users: number;
    total_requests: number;
    updated_at: string | Date;
}
export interface AppsListLinkRenderProps {
    app: AppsListItem;
    className?: string;
    children: ReactNode;
}
export interface AppsListViewProps {
    apps: AppsListItem[];
    deletingId?: string | null;
    renderAppLink: (props: AppsListLinkRenderProps) => ReactNode;
    onCopyUrl?: (app: AppsListItem) => void;
    onDeleteApp?: (app: AppsListItem) => void;
}
export declare function AppsListView({ apps, deletingId, renderAppLink, onCopyUrl, onDeleteApp, }: AppsListViewProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=apps-list-view.d.ts.map