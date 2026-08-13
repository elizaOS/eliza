/**
 * Guards the consolidated homepage deployment authority: homepage source is
 * embedded into packages/app and only the unified cloud workflow may deploy it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const workflowsDirectory = path.join(repositoryRoot, ".github/workflows");
const workflowPath = path.join(workflowsDirectory, "cloud-cf-deploy.yml");
const qualityWorkflowPath = path.join(workflowsDirectory, "quality.yml");

describe("homepage deployment workflow", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const qualityWorkflow = readFileSync(qualityWorkflowPath, "utf8");
  const homepagePackage = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "packages/homepage/package.json"),
      "utf8",
    ),
  ) as { name?: string; scripts?: Record<string, string> };
  const appPackage = JSON.parse(
    readFileSync(
      path.join(repositoryRoot, "packages/app/package.json"),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };
  const devAll = readFileSync(
    path.join(repositoryRoot, "packages/scripts/dev-all.mjs"),
    "utf8",
  );

  it("retires every standalone homepage application lifecycle", () => {
    expect(
      existsSync(path.join(workflowsDirectory, "deploy-homepage.yml")),
    ).toBe(false);
    expect(homepagePackage.name).toBe("@elizaos/homepage-source");
    for (const script of [
      "predev",
      "dev",
      "prebuild",
      "build",
      "postbuild",
      "preview",
      "deploy:production",
      "deploy:preview",
    ]) {
      expect(homepagePackage.scripts?.[script]).toBeUndefined();
    }
    expect(workflow).not.toContain("eliza-app-home");
    expect(devAll).not.toContain("packages/homepage");
    expect(devAll).not.toContain("DEV_ALL_HOMEPAGE_PORT");
  });

  it("builds homepage changes into the single eliza-app artifact", () => {
    expect(appPackage.scripts?.["prebuild:web"]).toBe("bun run prebuild");
    expect(workflow).toContain('      - "packages/homepage/**"');
    expect(workflow).toContain("Build consolidated frontend artifact");
    expect(workflow).toContain("Upload consolidated frontend artifact");
    expect(workflow).toContain("PAGES_PROJECT: eliza-app");
    expect(workflow).toContain("https://eliza.app");
    expect(workflow).toContain("https://cloud.eliza.app");
    expect(workflow).toContain("https://staging.eliza.app");
    expect(workflow).toContain("https://cloud-staging.eliza.app");
  });

  it("resolves matched Telegram configuration for canonical and preview builds", () => {
    expect(workflow).toContain("resolve-pages-environment-config:");
    expect(workflow).toContain("resolve-pages-preview-config:");
    expect(workflow).toContain("VITE_TELEGRAM_BOT_ID must be numeric");
    expect(workflow.match(/TELEGRAM_BOT_ID=7684336618/g)).toHaveLength(2);
    expect(workflow.match(/TELEGRAM_BOT_USERNAME=Elizav2_Bot/g)).toHaveLength(
      2,
    );
    expect(
      workflow.match(
        /VITE_TELEGRAM_BOT_ID and VITE_TELEGRAM_BOT_USERNAME must be configured together/g,
      ),
    ).toHaveLength(2);
    expect(workflow).toContain(
      "VITE_TELEGRAM_BOT_ID: $" +
        "{{ needs.resolve-pages-environment-config.outputs.telegram_bot_id || needs.resolve-pages-preview-config.outputs.telegram_bot_id }}",
    );
    expect(workflow).toContain(
      "VITE_TELEGRAM_BOT_USERNAME: $" +
        "{{ needs.resolve-pages-environment-config.outputs.telegram_bot_username || needs.resolve-pages-preview-config.outputs.telegram_bot_username }}",
    );
    expect(workflow).toContain(
      "VITE_TELEGRAM_BOT_ID: $" +
        "{{ needs.build-pages.outputs.telegram_bot_id }}",
    );
    expect(workflow).toContain(
      "VITE_TELEGRAM_BOT_USERNAME: $" +
        "{{ needs.build-pages.outputs.telegram_bot_username }}",
    );
  });

  it("validates homepage source while building only packages/app in quality CI", () => {
    expect(qualityWorkflow).toContain("consolidated-frontend-build:");
    expect(qualityWorkflow).toContain("Validate homepage source contracts");
    expect(qualityWorkflow).toContain("working-directory: packages/homepage");
    expect(qualityWorkflow).toContain(
      "run: bun run typecheck && bun run lint:check && bun run test && bun run check:snapshot-inventory",
    );
    expect(qualityWorkflow).toContain("Build the only deployable frontend");
    expect(qualityWorkflow).toContain("working-directory: packages/app");
    expect(qualityWorkflow).toContain("run: bun run build:web");
    expect(qualityWorkflow).not.toContain(
      "working-directory: packages/homepage\n        run: bun run build",
    );
    expect(qualityWorkflow).not.toContain(
      "PLAYWRIGHT_INSTALL_CWD=packages/homepage",
    );
  });
});
