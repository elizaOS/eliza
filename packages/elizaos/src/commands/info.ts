import pc from "picocolors";
import { getTemplateById, loadManifest, TEMPLATE_ICONS } from "../manifest.js";
import type { InfoOptions } from "../types.js";

export function info(options: InfoOptions): void {
  const manifest = loadManifest();
  const template = options.template
    ? getTemplateById(options.template)
    : undefined;
  const templates = options.template
    ? template
      ? [template]
      : []
    : options.language
      ? manifest.templates.filter((template) =>
          template.languages.includes(options.language as string),
        )
      : manifest.templates;

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

  if (options.template && !template) {
    console.log(pc.yellow(`Template '${options.template}' not found.`));
    console.log();
  }
}
