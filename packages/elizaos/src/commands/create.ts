import * as fs from "node:fs";
import * as path from "node:path";
import * as clack from "@clack/prompts";
import pc from "picocolors";
import {
  getTemplateById,
  getTemplates,
  getTemplatesDir,
  TEMPLATE_ICONS,
} from "../manifest.js";
import { getCliVersion } from "../package-info.js";
import { writeProjectMetadata } from "../project-metadata.js";
import {
  buildFullstackTemplateValues,
  buildMetadata,
  buildPluginTemplateValues,
  getTemplateReplacementEntries,
  hydrateGitSubmoduleWorkspace,
  initializeGitSubmodule,
  renderTemplateTree,
  resolveTemplateSourceDir,
  resolveTemplateUpstream,
} from "../scaffold.js";
import type {
  CreateOptions,
  FullstackTemplateValues,
  PluginTemplateValues,
} from "../types.js";

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
};

function normalizeProjectName(value: string): string {
  const clamped = value.length > 256 ? value.slice(0, 256) : value;
  return clamped
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unwrapPromptResult<T>(value: T, message = "Operation cancelled."): T {
  if (clack.isCancel(value)) {
    clack.cancel(message);
    process.exit(0);
  }
  return value;
}

function validateProjectDirectory(
  name: string | undefined,
): string | Error | undefined {
  const normalized = normalizeProjectName(name ?? "");
  if (!normalized) return "Project name is required";
  if (fs.existsSync(normalized))
    return `Directory '${normalized}' already exists`;
  return undefined;
}

function getNextSteps(options: {
  projectDir: string;
  skipUpstream?: boolean;
  templateId: string;
}): string[] {
  const steps = [`cd ${options.projectDir}`];
  if (options.templateId === "project" && options.skipUpstream) {
    steps.push("npx elizaos upgrade");
  }
  steps.push("bun install");
  steps.push(options.templateId === "plugin" ? "bun run build" : "bun run dev");
  return steps;
}

async function promptTemplateId(initial?: string): Promise<string> {
  if (initial) return initial;
  const templates = getTemplates();
  const choice = await clack.select({
    message: "Select a template:",
    options: templates.map((template) => ({
      value: template.id,
      label: `${TEMPLATE_ICONS[template.id] || "📦"} ${template.name}`,
      hint: template.description,
    })),
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Operation cancelled.");
    process.exit(0);
  }

  return choice as string;
}

async function promptLanguage(
  templateId: string,
  initial: string | undefined,
): Promise<string | undefined> {
  const template = getTemplateById(templateId);
  if (!template) return undefined;
  if (template.languages.length <= 1) {
    return template.languages[0];
  }
  if (initial) return initial;

  const choice = await clack.select({
    message: "Select a language:",
    options: template.languages.map((language) => ({
      value: language,
      label: LANGUAGE_NAMES[language] || language,
    })),
  });

  if (clack.isCancel(choice)) {
    clack.cancel("Operation cancelled.");
    process.exit(0);
  }

  return choice as string;
}

async function promptProjectName(
  templateId: string,
  initial?: string,
): Promise<string> {
  if (initial) return normalizeProjectName(initial);
  const defaultValue =
    templateId === "plugin" ? "plugin-example" : "my-project";
  const input = await clack.text({
    defaultValue,
    message: "Project name:",
    placeholder: defaultValue,
    validate: validateProjectDirectory,
  });

  if (clack.isCancel(input)) {
    clack.cancel("Operation cancelled.");
    process.exit(0);
  }

  return normalizeProjectName(input as string);
}

async function promptPluginValues(
  projectName: string,
  options: CreateOptions,
): Promise<PluginTemplateValues> {
  const normalized = normalizeProjectName(projectName);
  const defaultRepoName = normalized.startsWith("plugin-")
    ? normalized
    : `plugin-${normalized}`;
  const githubUsername = options.githubUsername?.trim()
    ? options.githubUsername.trim()
    : options.yes
      ? "your-github-username"
      : (unwrapPromptResult(
          await clack.text({
            defaultValue: "your-github-username",
            message: "GitHub username:",
          }),
        ) as string);
  const pluginDescription = options.description?.trim()
    ? options.description.trim()
    : options.yes
      ? `${defaultRepoName} plugin for elizaOS`
      : (unwrapPromptResult(
          await clack.text({
            defaultValue: `${defaultRepoName} plugin for elizaOS`,
            message: "Plugin description:",
          }),
        ) as string);
  const repoUrl =
    options.repoUrl?.trim() ||
    `https://github.com/${githubUsername}/${defaultRepoName}`;

  return buildPluginTemplateValues({
    elizaVersion: "beta",
    githubUsername,
    pluginDescription,
    projectName: defaultRepoName,
    repoUrl,
  });
}

export async function create(
  projectName: string | undefined,
  options: CreateOptions,
): Promise<void> {
  clack.intro(pc.bgCyan(pc.black(" elizaOS ")));

  const templateId = await promptTemplateId(options.template);
  const template = getTemplateById(templateId);
  if (!template) {
    clack.cancel(`Template '${templateId}' not found.`);
    process.exit(1);
  }

  const language = await promptLanguage(template.id, options.language);
  if (language && !template.languages.includes(language)) {
    clack.cancel(
      `Template '${template.name}' does not support language '${language}'.`,
    );
    process.exit(1);
  }

  let finalProjectName = await promptProjectName(template.id, projectName);
  if (template.id === "plugin" && !finalProjectName.startsWith("plugin-")) {
    finalProjectName = `plugin-${finalProjectName}`;
  }

  if (fs.existsSync(finalProjectName)) {
    clack.cancel(`Directory '${finalProjectName}' already exists.`);
    process.exit(1);
  }

  const values: PluginTemplateValues | FullstackTemplateValues =
    template.id === "plugin"
      ? await promptPluginValues(finalProjectName, options)
      : buildFullstackTemplateValues(finalProjectName);

  if (!options.yes) {
    const confirmed = await clack.confirm({
      message: `Create ${pc.cyan(template.name)} in ${pc.cyan(finalProjectName)}?`,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }
  }

  const destinationDir = path.resolve(process.cwd(), finalProjectName);
  const sourceDir = resolveTemplateSourceDir({
    template,
    templatesDir: getTemplatesDir(),
  });
  const replacements = getTemplateReplacementEntries({
    templateId: template.id,
    values: values as Record<string, string>,
  });

  const spinner = clack.spinner();
  spinner.start("Creating project...");

  const managedFiles = renderTemplateTree({
    destinationDir,
    replacements,
    sourceDir,
  });

  if (template.upstream && !options.skipUpstream) {
    const upstream = resolveTemplateUpstream(template.upstream);
    spinner.message("Initializing upstream eliza checkout...");
    initializeGitSubmodule({
      branch: upstream.branch,
      projectRoot: destinationDir,
      repo: upstream.repo,
      submodulePath: upstream.path,
    });
    hydrateGitSubmoduleWorkspace({
      projectRoot: destinationDir,
      upstream,
    });
  }

  writeProjectMetadata(
    destinationDir,
    buildMetadata({
      cliVersion: getCliVersion(),
      language,
      managedFiles,
      template,
      values: values as Record<string, string>,
    }),
  );

  spinner.stop("Project created successfully!");

  console.log();
  clack.note(
    getNextSteps({
      projectDir: finalProjectName,
      skipUpstream: options.skipUpstream,
      templateId: template.id,
    }).join("\n"),
    "Next steps",
  );
  clack.outro(`${pc.green("✨")} Your ${template.name} is ready!`);
}
