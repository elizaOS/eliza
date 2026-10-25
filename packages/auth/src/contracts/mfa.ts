export type TenantMfaPolicyConfig = {
  maxAgeSeconds?: number;
  maxAgeFor?: {
    vaultSigning?: number;
    keyImport?: number;
    keyExport?: number;
    recoveryCodes?: number;
    tenantAdmin?: number;
  };
  requireFor?: {
    vaultSigning?: boolean;
    keyImport?: boolean;
    keyExport?: boolean;
    recoveryCodes?: boolean;
    tenantAdmin?: boolean;
  };
  disableFor?: {
    keyImport?: boolean;
    keyExport?: boolean;
  };
  allowDelegatedSignerAutomation?: boolean;
  allowKeyQuorumAutomation?: boolean;
};
