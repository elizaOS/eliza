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
    expect(lifecycle).toContain("listByOrganizationForWrite");
    expect(lifecycle).not.toContain("deactivateStewardPlatformUser");
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
    expect(publicPage).toContain("server-owned availability");
    expect(publicPage).toContain("support@eliza.cloud");
    expect(publicPage).not.toContain("useSearchParams");
    expect(publicPage).not.toContain("requested=");
    expect(publicPage).not.toContain("Access is disabled immediately");
    expect(publicPage).not.toContain("sign back in");
    expect(read("cloud/shared/src/lib/cron/cloudflare-cron.ts")).toContain(
      '"/api/cron/process-account-deletions"',
    );
  });
});
