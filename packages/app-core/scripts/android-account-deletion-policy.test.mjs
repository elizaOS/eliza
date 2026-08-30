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
  it("keeps Android on the canonical full application shell", () => {
    const entry = read("app/src/entry.ts");

    expect(entry).toContain('import("./main")');
    expect(entry).not.toContain("main.android-cloud");
    expect(
      fs.existsSync(path.join(root, "app/src/main.android-cloud.tsx")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(root, "ui/src/android-cloud/AndroidCloudApp.tsx"),
      ),
    ).toBe(false);
  });

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
    const lifecycle = read(
      "ui/src/android-cloud/android-cloud-account-lifecycle.ts",
    );
    const parser = read("ui/src/android-cloud/account-deletion-contract.ts");
    const settings = read("ui/src/android-cloud/AndroidCloudSettings.tsx");
    const settingsSection = read(
      "ui/src/android-cloud/AndroidAccountLifecycleSection.tsx",
    );
    const sectionRegistry = read(
      "ui/src/components/settings/settings-sections.ts",
    );
    const seam = read("ui/src/android-cloud/ACCOUNT_DELETION_CONTRACT_SEAM.md");

    expect(seam).toContain("90343b7265d3fef2c717c1ab6701cbe3d8b59036");
    expect(lifecycle).toContain('"/api/v1/me/account-deletion"');
    expect(lifecycle).toContain('"/api/public/account-deletion"');
    expect(lifecycle).toContain('"X-Account-Deletion-Status"');
    expect(lifecycle).toContain('"X-Account-Deletion-Recovery"');
    expect(lifecycle).toContain('confirmation: "CANCEL DELETION"');
    expect(lifecycle).toContain('"account_deletion_admission"');
    expect(lifecycle).toContain("const bytes = randomBytes(32)");
    expect(lifecycle).toContain("new Uint8Array(size)");
    expect(lifecycle).toContain("crypto.getRandomValues(bytes)");
    expect(lifecycle).toMatch(
      /data:\s*\{\s*confirmation:\s*"DELETE",\s*admissionCredential:\s*admission\s*\}/,
    );
    expect(lifecycle).toContain("admissionCredential");
    expect(lifecycle).toContain("persistCapabilities");
    expect(lifecycle).not.toContain("Math.random");
    expect(lifecycle).not.toContain("statusAccessEstablished");
    expect(settingsSection).toContain("androidCloudAccountLifecycle");
    expect(sectionRegistry).toContain(
      'nonCatalogMeta("android-account-lifecycle")',
    );
    expect(sectionRegistry).toContain("androidCloudOnly: true");
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

  it("keeps deletion admission fenced until the lifecycle reservation exists", () => {
    const route = read("cloud/api/v1/me/account-deletion/route.ts");
    const lifecycle = read("cloud/shared/src/lib/services/account-deletion.ts");
    const resourcePurge = read(
      "cloud/shared/src/lib/services/account-deletion-resource-purge.ts",
    );
    const users = read("cloud/shared/src/lib/services/users.ts");
    const appCleanup = read("cloud/shared/src/lib/services/app-cleanup.ts");
    const publicPage = read(
      "ui/src/cloud/public-pages/pages/legal/account-deletion-page.tsx",
    );
    expect(route).toContain('body.confirmation !== "DELETE"');
    expect(lifecycle).toContain('"TRANSFER_REQUIRED"');
    expect(lifecycle).toContain('"LIFECYCLE_RESERVATION_REQUIRED"');
    expect(lifecycle).toContain("reservePersonalAccountDeletion");
    expect(lifecycle).toContain("deactivateStewardPlatformUser");
    expect(lifecycle).toContain("reactivateStewardPlatformUser");
    expect(lifecycle).not.toContain("deleteStewardPlatformUser");
    expect(lifecycle).toContain("recoverStaleProcessing");
    expect(lifecycle).toContain("purgePersonalOrganizationResources");
    expect(lifecycle).toContain("markActionRequired");
    expect(resourcePurge).toContain("deleteBillingCustomer");
    expect(resourcePurge).toContain("prepareManagedDomains");
    expect(resourcePurge).toContain('authorization: "account_deletion"');
    expect(resourcePurge).toContain("purgeOrganizationObjectStorage");
    expect(users).toContain("deletePersonalOrganizationAtomically");
    expect(appCleanup).toContain("requireContainerTeardownCompletion");
    expect(publicPage).toContain("30-day recovery");
    expect(publicPage).toContain("support@eliza.cloud");
    expect(publicPage).not.toContain("sign back in");
    expect(read("cloud/shared/src/lib/cron/cloudflare-cron.ts")).toContain(
      '"/api/cron/process-account-deletions"',
    );
  });
});
