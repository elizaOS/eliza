import * as fs from "node:fs";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import { getTemplateById, getTemplatesDir } from "../manifest.js";
import { getCliVersion } from "../package-info.js";
import {
  readProjectMetadata,
  writeProjectMetadata,
} from "../project-metadata.js";
import {
  buildMetadata,
  createRenderedTempDir,
  getTemplateReplacementEntries,
  hydrateGitSubmoduleWorkspace,
  resolveTemplateSourceDir,
  resolveTemplateUpstream,
  updateGitSubmodule,
  updateManagedFiles,
} from "../scaffold.js";
import type { UpgradeOptions } from "../types.js";

export async function upgrade(options: UpgradeOptions): Promise<void> {
  const projectRoot = process.cwd();
  const metadata = readProjectMetadata(projectRoot);
  if (!metadata) {
    clack.cancel(
      "No .elizaos/template.json metadata found in the current directory.",
    );
    process.exit(1);
  }

  const template = getTemplateById(metadata.templateId);
  if (!template) {
    clack.cancel(
      `Template '${metadata.templateId}' is not available in this CLI build.`,
    );
    process.exit(1);
  }

  const replacements = getTemplateReplacementEntries({
    templateId: template.id,
    values: metadata.values,
  });
  const sourceDir = resolveTemplateSourceDir({
    template,
    templatesDir: getTemplatesDir(),
  });

  clack.intro(pc.bgCyan(pc.black(" elizaOS ")));
  const spinner = clack.spinner();
  spinner.start("Rendering latest template...");

  const rendered = createRenderedTempDir({
    replacements,
    sourceDir,
  });

  const result = updateManagedFiles({
    currentMetadata: metadata,
    dryRun: options.check || options.dryRun,
    projectRoot,
    renderedDir: rendered.dir,
    renderedManagedFiles: rendered.managedFiles,
  });

  if (template.upstream && !options.skipUpstream) {
    const upstream = resolveTemplateUpstream(template.upstream);
    spinner.message("Updating upstream eliza checkout...");
    updateGitSubmodule({
      branch: upstream.branch,
      dryRun: options.check || options.dryRun,
      projectRoot,
      repo: upstream.repo,
      submodulePath: upstream.path,
    });
    hydrateGitSubmoduleWorkspace({
      dryRun: options.check || options.dryRun,
      projectRoot,
      upstream,
    });
  }

  spinner.stop(
    options.check || options.dryRun
      ? "Upgrade check complete."
      : "Upgrade complete.",
  );

  fs.rmSync(rendered.dir, { force: true, recursive: true });

  if (!(options.check || options.dryRun)) {
    writeProjectMetadata(projectRoot, {
      ...buildMetadata({
        cliVersion: getCliVersion(),
        language: metadata.language,
        managedFiles: result.nextManagedFiles,
        template,
        values: metadata.values,
      }),
      createdAt: metadata.createdAt,
    });
  }

  console.log();
  clack.note(
    [
      `Updated: ${result.updated.length}`,
      `Created: ${result.created.length}`,
      `Deleted: ${result.deleted.length}`,
      `Conflicts: ${result.conflicts.length}`,
    ].join("\n"),
    options.check || options.dryRun ? "Upgrade check" : "Upgrade result",
  );

  if (result.conflicts.length > 0) {
    console.log();
    console.log(pc.yellow("Skipped files with local changes:"));
    for (const conflict of result.conflicts) {
      console.log(`  - ${conflict}`);
    }
  }

  console.log();
}
