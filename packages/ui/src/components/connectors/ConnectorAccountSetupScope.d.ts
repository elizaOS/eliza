import type { ReactNode } from "react";
export interface ConnectorAccountSetupScopeProps {
    provider: string;
    connectorId?: string;
    children: (accountId: string | null) => ReactNode;
}
export declare function ConnectorAccountSetupScope({ provider, connectorId, children, }: ConnectorAccountSetupScopeProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConnectorAccountSetupScope.d.ts.map