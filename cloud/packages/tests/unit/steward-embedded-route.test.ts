import { describe, expect, it } from "bun:test";
import {
  isPublicStewardTenantConfigPath,
  PUBLIC_STEWARD_TENANT_CONFIG,
} from "../../../apps/api/src/steward/embedded";

describe("embedded Steward route", () => {
  it("recognizes the public tenant config path behind the same-origin /steward mount", () => {
    expect(isPublicStewardTenantConfigPath("/steward/tenants/config")).toBe(true);
    expect(isPublicStewardTenantConfigPath("/tenants/config")).toBe(true);
    expect(isPublicStewardTenantConfigPath("/steward/auth/providers")).toBe(false);
  });

  it("exposes only non-sensitive public feature configuration", () => {
    expect(PUBLIC_STEWARD_TENANT_CONFIG).toEqual({
      features: {
        showFundingQR: true,
        showTransactionHistory: true,
        showSpendDashboard: true,
        showPolicyControls: true,
        showApprovalQueue: true,
        showSecretManager: false,
        enableSolana: true,
        showChainSelector: false,
        allowAddressExport: true,
      },
    });
  });
});
