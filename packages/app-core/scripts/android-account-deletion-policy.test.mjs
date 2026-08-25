/** Verifies the Android deletion disclosure and its fail-closed Cloud admission contract. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

describe("Android Play account-deletion contract", () => {
  it("ships real in-app and external deletion paths", () => {
    const privacy = read(
      "ui/src/cloud/account-security/components/privacy-panel.tsx",
    );
    const routes = read("ui/src/cloud/public-pages/register.ts");
    const webEntry = read("app/src/web-entry-policy.ts");
    expect(privacy).toContain("<AccountDeletionDialog />");
    expect(privacy).not.toMatch(
      /delete-account-trigger[\s\S]{0,300}\bdisabled\b/,
    );
    expect(routes).toContain('path: "account-deletion"');
    expect(webEntry).toContain('"/account-deletion"');
    for (const locale of fs.readdirSync(
      path.join(root, "ui/src/i18n/locales"),
    )) {
      if (!locale.endsWith(".json")) continue;
      expect(read(`ui/src/i18n/locales/${locale}`)).not.toContain(
        '"cloud.privacyPanel.deletionComingSoon"',
      );
      expect(read(`ui/src/i18n/locales/${locale}`)).not.toContain(
        '"cloud.privacyPanel.deletionScheduled"',
      );
    }
  });

  it("pins Android to the stable capability contract without backend ownership", () => {
    const entry = read("app/src/main.android-cloud.tsx");
    const parser = read("ui/src/android-cloud/account-deletion-contract.ts");
    const settings = read("ui/src/android-cloud/AndroidCloudSettings.tsx");
    const seam = read("ui/src/android-cloud/ACCOUNT_DELETION_CONTRACT_SEAM.md");

    expect(seam).toContain("90343b7265d3fef2c717c1ab6701cbe3d8b59036");
    expect(entry).toContain('"/api/v1/me/account-deletion"');
    expect(entry).toContain('"/api/public/account-deletion"');
    expect(entry).toContain('"X-Account-Deletion-Status"');
    expect(entry).toContain('"X-Account-Deletion-Recovery"');
    expect(entry).toContain('confirmation: "CANCEL DELETION"');
    expect(entry).toContain('"accountDeletionAdmission"');
    expect(entry).toContain("new Uint8Array(32)");
    expect(entry).toContain("crypto.getRandomValues(bytes)");
    expect(entry).toContain(
      'data: { confirmation: "DELETE", admissionCredential }',
    );
    expect(entry).toContain("getOrCreateDeletionAdmissionCredential");
    expect(entry).toContain("persistDeletionCapabilities");
    expect(entry).toContain('from "@elizaos/ui/error-boundary"');
    expect(entry).not.toContain('from "@elizaos/ui"');
    expect(entry).not.toContain("Math.random");
    expect(entry).not.toContain("statusAccessEstablished");
    expect(parser).toContain("statusCredential: string;");
    expect(parser).toContain("recoveryCredential: string;");
    expect(parser).toContain('| "canceling"');
    expect(parser).toContain("accessState: AccountDeletionAccessState;");
    expect(parser).toContain("nextAction: AccountDeletionNextAction;");
    expect(parser).toContain('nextAction: "wait_for_reconciliation"');
    expect(settings).toContain("Type CANCEL DELETION");
    expect(settings).toContain("Restoring account access");
    expect(settings).toContain("Existing sessions and API keys remain revoked");
    expect(settings).toContain("Save data export");
  });
});
