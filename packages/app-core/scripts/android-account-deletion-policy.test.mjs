/** Verifies mobile-store deletion disclosures against the server-authoritative Cloud contract. */

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

  it("binds new requests to the durable reservation and post-session capability contract", () => {
    const route = read("cloud/api/v1/me/account-deletion/route.ts");
    const publicRoute = read("cloud/api/public/account-deletion/route.ts");
    const lifecycle = read("cloud/shared/src/lib/services/account-deletion.ts");
    const lifecycleTypes = read("cloud/shared/src/types/account-lifecycle.ts");
    const deletionClient = read(
      "ui/src/cloud/account-security/data/account-deletion-client.ts",
    );
    const repository = read(
      "cloud/shared/src/db/repositories/account-deletion-requests.ts",
    );
    const resourcePurge = read(
      "cloud/shared/src/lib/services/account-deletion-resource-purge.ts",
    );
    const users = read("cloud/shared/src/lib/services/users.ts");
    const appCleanup = read("cloud/shared/src/lib/services/app-cleanup.ts");
    const publicPage = read(
      "ui/src/cloud/public-pages/pages/legal/account-deletion-page.tsx",
    );
    expect(route).toContain('body.confirmation !== "DELETE"');
    expect(route).toContain("requireRecentSessionUserWithOrg");
    expect(route).toContain("recoverAccountDeletionAdmission");
    expect(route).toContain("checkElizaMutatingRequestOrigin");
    expect(publicRoute).toContain('header("X-Account-Deletion-Status")');
    expect(publicRoute).toContain('header("X-Account-Deletion-Recovery")');
    expect(publicRoute).not.toContain("query(");
    expect(lifecycleTypes).toContain('"agent_control"');
    expect(lifecycleTypes).toContain('"subscription_cancellation"');
    expect(lifecycleTypes).toContain('"shared_member_exit"');
    expect(lifecycleTypes).toContain('"personal_account_deletion"');
    expect(lifecycleTypes).toContain(
      'accessState: "fenced" | "active" | "erased"',
    );
    expect(lifecycleTypes).toContain("AccountDeletionRequestBodyDto");
    expect(deletionClient).toContain("getOrCreateAdmissionCredential");
    expect(deletionClient).toContain("admissionCredential");
    expect(lifecycle).toContain('"TRANSFER_REQUIRED"');
    expect(lifecycle).toContain('"LIFECYCLE_RESERVATION_REQUIRED"');
    expect(lifecycle).toContain("reservePersonalAccountDeletion");
    expect(lifecycle).toContain("attemptImmediateStewardDeactivation");
    expect(lifecycle).toContain("reconcileCancelingStewardReactivations");
    expect(lifecycle).toContain("recoverStaleProcessing");
    expect(lifecycle).toContain("markActionRequired");
    expect(repository).toContain("finalizePersonalAccountDeletion");
    expect(repository).toContain("finalizeCancellationIfComplete");
    expect(repository).toContain('status: "canceling"');
    expect(repository).toContain('status: "canceled"');
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

  it("keeps store declarations gated on hosted proof instead of source tests", () => {
    const worksheet = read("app-core/docs/android-play-account-deletion.md");
    expect(worksheet).toContain("Current source candidate");
    expect(worksheet).toContain("Apple App Store review cross-check");
    expect(worksheet).toContain("source-candidate answers only");
    expect(worksheet).toContain("hosted disposable-account acceptance");
    expect(worksheet).toContain(
      "Do not claim App Store compliance from source tests alone",
    );
    expect(worksheet).not.toContain("Not for the current candidate");
    expect(worksheet).not.toContain("Not until the lifecycle gate is cleared");
  });
});
