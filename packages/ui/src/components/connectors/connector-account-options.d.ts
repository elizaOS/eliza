import type { ConnectorAccountCreateInput, ConnectorAccountPrivacy, ConnectorAccountPurpose, ConnectorAccountRole } from "../../api/client-agent";
export interface ConnectorAccountOption<T extends string> {
    value: T;
    label: string;
    description: string;
}
export type ConnectorPrivacyConfirmationRequirement = "none" | "typed" | "public";
export type ConnectorRoleConfirmationRequirement = "none" | "owner";
export declare const CONNECTOR_PLUGIN_MANAGED_MODE_ID = "plugin-managed";
export declare const CONNECTOR_ACCOUNT_MANAGEMENT_PANEL_PREFIX = "connector-account-management";
export type ConnectorManagementMode = typeof CONNECTOR_PLUGIN_MANAGED_MODE_ID | "cloud-managed" | "local-setup" | "local-config";
export interface ConnectorPluginManagedAccountOption extends ConnectorAccountOption<typeof CONNECTOR_PLUGIN_MANAGED_MODE_ID> {
    connectorId: string;
    provider: string;
    title: string;
    defaultRole: ConnectorAccountRole;
    defaultPurpose: readonly ConnectorAccountPurpose[];
    supportsOAuth: boolean;
    aliases?: readonly string[];
}
export declare const CONNECTOR_ACCOUNT_PURPOSE_OPTIONS: readonly ConnectorAccountOption<ConnectorAccountRole>[];
export declare const CONNECTOR_ACCOUNT_PRIVACY_OPTIONS: readonly ConnectorAccountOption<ConnectorAccountPrivacy>[];
export declare const CONNECTOR_PRIVACY_TYPED_CONFIRMATION = "SHARE";
export declare const CONNECTOR_PRIVACY_PUBLIC_CONFIRMATION = "PUBLIC";
export declare const CONNECTOR_OWNER_ROLE_CONFIRMATION = "OWNER";
export declare const CONNECTOR_PLUGIN_MANAGED_ACCOUNT_OPTIONS: readonly ConnectorPluginManagedAccountOption[];
export declare function normalizeConnectorCatalogId(connectorId: string): string;
export declare function getConnectorPluginManagedAccountOption(connectorId: string | undefined): ConnectorPluginManagedAccountOption | null;
export declare function hasConnectorPluginManagedAccounts(connectorId: string | undefined): boolean;
export declare function connectorAccountManagementPanelPluginId(connectorId: string): string | null;
export declare function parseConnectorAccountManagementPanelPluginId(pluginId: string): {
    provider: string;
    connectorId: string;
} | null;
export declare function getConnectorPluginManagedAccountCreateInput(connectorId: string): ConnectorAccountCreateInput | undefined;
export declare function getConnectorPurposeOption(value: ConnectorAccountRole | undefined): ConnectorAccountOption<ConnectorAccountRole>;
export declare function getConnectorPrivacyOption(value: ConnectorAccountPrivacy | undefined): ConnectorAccountOption<ConnectorAccountPrivacy>;
export declare function getConnectorPrivacyConfirmationRequirement(current: ConnectorAccountPrivacy | undefined, next: ConnectorAccountPrivacy): ConnectorPrivacyConfirmationRequirement;
export declare function isConnectorPrivacyConfirmationSatisfied(requirement: ConnectorPrivacyConfirmationRequirement, typedValue: string, publicAcknowledged: boolean): boolean;
export declare function getConnectorRoleConfirmationRequirement(current: ConnectorAccountRole | undefined, next: ConnectorAccountRole): ConnectorRoleConfirmationRequirement;
export declare function isConnectorRoleConfirmationSatisfied(requirement: ConnectorRoleConfirmationRequirement, typedValue: string): boolean;
//# sourceMappingURL=connector-account-options.d.ts.map