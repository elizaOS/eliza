/**
 * Template discovery command that prints the shipped template manifest in human
 * readable or JSON form. Named lookups that cannot be satisfied fail closed
 * with a non-zero exit instead of printing an empty successful listing.
 */

import pc from "picocolors";
import { getTemplateById, loadManifest, TEMPLATE_ICONS } from "../manifest.js";
import type {
  InfoOptions,
  TemplateDefinition,
  TemplatesManifest,
} from "../types.js";

function failInfo(options: InfoOptions, message: string): never {
  if (options.json) {
    console.log(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(pc.red(message));
  }
  process.exit(1);
}

function printTemplates(
  options: InfoOptions,
  manifest: TemplatesManifest,
  templates: TemplateDefinition[],
): void {
  if (options.json) {
    console.log(JSON.stringify(templates, null, 2));
    return;
  }

  console.log();
  console.log(pc.bold(pc.cyan("elizaOS Templates")));
  console.log(pc.dim(`Generated: ${manifest.generatedAt}`));
  console.log();

  for (const template of templates) {
    console.log(
      `  ${TEMPLATE_ICONS[template.id] || "📦"} ${pc.bold(template.name)}`,
    );
    console.log(`     ${pc.dim(template.description)}`);
    console.log(
      `     ${pc.dim("Languages:")} ${template.languages.join(", ") || "n/a"}`,
    );
    console.log();
  }
}

export function info(options: InfoOptions): void {
  const manifest = loadManifest();

  if (options.template) {
    const template = getTemplateById(options.template);
    if (!template) {
      failInfo(options, `Template '${options.template}' not found.`);
    }
    if (options.language && !template.languages.includes(options.language)) {
      failInfo(
        options,
        `Template '${template.name}' does not support language '${options.language}'.`,
      );
    }
    printTemplates(options, manifest, [template]);
    return;
  }

  const templates = options.language
    ? manifest.templates.filter((template) =>
        template.languages.includes(options.language as string),
      )
    : manifest.templates;
  printTemplates(options, manifest, templates);
}
