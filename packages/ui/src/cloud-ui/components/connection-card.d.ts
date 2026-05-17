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
declare function ConnectionLoadingCard({ className }: {
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
declare function ConnectionConnectedBadge({ label, className, }: {
    label?: string;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
interface ConnectionIdentityPanelProps {
    icon: React.ReactNode;
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
    iconClassName?: string;
    className?: string;
    actions?: React.ReactNode;
}
declare function ConnectionIdentityPanel({ icon, title, subtitle, children, iconClassName, className, actions, }: ConnectionIdentityPanelProps): import("react/jsx-runtime").JSX.Element;
interface ConnectionCalloutProps {
    title?: React.ReactNode;
    items?: React.ReactNode[];
    children?: React.ReactNode;
    tone?: "blue" | "green" | "red" | "yellow" | "muted";
    className?: string;
}
declare function ConnectionCallout({ title, items, children, tone, className, }: ConnectionCalloutProps): import("react/jsx-runtime").JSX.Element;
interface ConnectionInstructionsProps {
    title: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    children: React.ReactNode;
    triggerClassName?: string;
    contentClassName?: string;
}
declare function ConnectionInstructions({ title, open, onOpenChange, children, triggerClassName, contentClassName, }: ConnectionInstructionsProps): import("react/jsx-runtime").JSX.Element;
interface ConnectionCopyRowProps {
    label: React.ReactNode;
    value: string;
    onCopied?: (value: string) => void;
    copyLabel?: string;
    className?: string;
}
declare function ConnectionCopyRow({ label, value, onCopied, copyLabel, className, }: ConnectionCopyRowProps): import("react/jsx-runtime").JSX.Element;
interface ConnectionDisconnectActionProps {
    title: React.ReactNode;
    description: React.ReactNode;
    onDisconnect: () => void;
    isDisconnecting?: boolean;
    buttonLabel?: string;
    confirmLabel?: string;
    triggerIcon?: React.ReactNode;
}
declare function ConnectionDisconnectAction({ title, description, onDisconnect, isDisconnecting, buttonLabel, confirmLabel, triggerIcon, }: ConnectionDisconnectActionProps): import("react/jsx-runtime").JSX.Element;
declare function ConnectionFooterActions({ note, children, className, }: {
    note?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
}): import("react/jsx-runtime").JSX.Element;
declare function ConnectionCard({ name, icon, description, status, connectedContent, setupContent, notConfiguredMessage, statusBadge, className, }: ConnectionCardProps): import("react/jsx-runtime").JSX.Element;
export type { ConnectionCardProps, ConnectionStatus };
export { ConnectionCallout, ConnectionCard, ConnectionConnectedBadge, ConnectionCopyRow, ConnectionDisconnectAction, ConnectionFooterActions, ConnectionIdentityPanel, ConnectionInstructions, ConnectionLoadingCard, };
//# sourceMappingURL=connection-card.d.ts.map