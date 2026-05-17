import type * as React from "react";
type ConnectionStatus = "loading" | "not-configured" | "connected" | "disconnected";
interface ConnectionCardProps {
    /** Integration name (e.g. "Discord Bot") */
    name: string;
    /** Icon element for the integration */
    icon: React.ReactNode;
    /** Brand accent color class (e.g. "text-[#5865F2]") */
    brandColorClass?: string;
    /** Short description of the integration */
    description: string;
    /** Current connection status */
    status: ConnectionStatus;
    /** Content shown when connected */
    connectedContent?: React.ReactNode;
    /** Content shown when disconnected (setup form) */
    setupContent?: React.ReactNode;
    /** Content shown when not configured */
    notConfiguredMessage?: string;
    /** Status badge shown in the header when connected */
    statusBadge?: React.ReactNode;
    /** Additional CSS classes */
    className?: string;
}
declare function ConnectionCard({ name, icon, description, status, connectedContent, setupContent, notConfiguredMessage, statusBadge, className, }: ConnectionCardProps): import("react/jsx-runtime").JSX.Element;
export type { ConnectionCardProps, ConnectionStatus };
export { ConnectionCard };
//# sourceMappingURL=connection-card.d.ts.map