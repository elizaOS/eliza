import * as React from "react";
export type ConnectionState = "connected" | "disconnected" | "error";
export interface ConnectionStatusProps extends React.HTMLAttributes<HTMLDivElement> {
    state: ConnectionState;
    /** Custom label — overrides the default state label */
    label?: string;
    /** Override label for "Connected" state */
    connectedLabel?: string;
    /** Override label for "Disconnected" state */
    disconnectedLabel?: string;
    /** Override label for "Error" state */
    errorLabel?: string;
}
export declare const ConnectionStatus: React.ForwardRefExoticComponent<ConnectionStatusProps & React.RefAttributes<HTMLDivElement>>;
//# sourceMappingURL=connection-status.d.ts.map