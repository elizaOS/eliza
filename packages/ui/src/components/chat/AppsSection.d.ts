/**
 * Apps widget section — shown at the top of the chat widget sidebar.
 *
 * Renders running apps first (with a health-state ring), then favorited apps
 * that are not currently running. Clicking an app launches / focuses it.
 */
import type { ReactNode } from "react";
export interface AppsSectionProps {
    /** Optional action node rendered at the top-right of the section header. */
    headerAction?: ReactNode;
}
export declare function AppsSection({ headerAction }?: AppsSectionProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=AppsSection.d.ts.map