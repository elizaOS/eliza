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
  });

  it("keeps the server lifecycle and truthful retention disclosure wired", () => {
    const route = read("cloud/api/v1/me/account-deletion/route.ts");
    const lifecycle = read("cloud/shared/src/lib/services/account-deletion.ts");
    const publicPage = read(
      "ui/src/cloud/public-pages/pages/legal/account-deletion-page.tsx",
    );
    expect(route).toContain('body.confirmation !== "DELETE"');
    expect(lifecycle).toContain("deactivateStewardPlatformUser");
    expect(lifecycle).toContain("deleteStewardPlatformUser");
    expect(lifecycle).toContain("recoverStaleProcessing");
    expect(publicPage).toContain("within 30 days");
    expect(publicPage).toContain("support@eliza.cloud");
    expect(publicPage).not.toContain("sign back in");
    expect(read("cloud/shared/src/lib/cron/cloudflare-cron.ts")).toContain(
      '"/api/cron/process-account-deletions"',
    );
  });
});
