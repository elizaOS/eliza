import type { ConnectorAccountRecord } from "../../api/client-agent";
export declare const CONNECTOR_SEND_AS_METADATA_KEY = "connectorSendAs";
export interface ConnectorSendAsContext {
    provider: string;
    connectorId?: string;
    source?: string;
    channel?: string;
    channelLabel?: string;
    writeCapable?: boolean;
    requiresAccount?: boolean;
}
export interface ConnectorSendAsSnapshot {
    accountId: string;
    source: string;
    channel?: string;
    provider: string;
    connectorId: string;
    label?: string;
    handle?: string | null;
    externalId?: string | null;
    status?: string;
    role?: string;
    purpose?: string[];
    privacy?: string;
    isDefault?: boolean;
}
export interface NormalizedConnectorSendAsContext extends ConnectorSendAsContext {
    provider: string;
    connectorId: string;
    source: string;
}
export declare function normalizeConnectorSendAsContext(context: ConnectorSendAsContext | null | undefined): NormalizedConnectorSendAsContext | null;
export declare function connectorAccountDisplayName(account: Pick<ConnectorAccountRecord, "label" | "handle" | "externalId" | "id">): string;
export declare function isConnectorAccountUsable(account: ConnectorAccountRecord | null | undefined): boolean;
export declare function shouldShowConnectorAccountPicker(context: ConnectorSendAsContext | null | undefined, accounts: ConnectorAccountRecord[]): boolean;
export declare function buildConnectorSendAsMetadata(context: ConnectorSendAsContext | null | undefined, account: ConnectorAccountRecord | null | undefined): Record<string, unknown> | undefined;
export declare function mergeConnectorSendAsMetadata(metadata: Record<string, unknown> | undefined, sendAsMetadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
export declare function connectorWriteConfirmationKey(context: ConnectorSendAsContext | null | undefined, account: ConnectorAccountRecord | null | undefined): string | null;
export declare function isLikelyAccountRequiredError(error: unknown): boolean;
//# sourceMappingURL=connector-send-as.d.ts.map