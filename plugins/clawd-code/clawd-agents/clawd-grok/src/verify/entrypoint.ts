import type { TaskRequest, VerifyRecipe } from "../types/index";
import type { SandboxSettings } from "../utils/settings";
import { ensureVerifyCheckpoint, type PreparedVerifyCheckpoint } from "./checkpoint";
import { loadVerifyEnvironment } from "./environment";
import { buildBrowserGuidance, buildEvidenceGuidance, buildReadinessGuidance } from "./evidence";
import {
  defaultShellInit,
  detectPackageManager,
  getNodeWebBootstrapCommands,
  getNodeWebShellInitCommands,
  inferVerifyProjectProfile,
  normalizeVerifyAppKind,
  type VerifyProjectProfile,
} from "./recipes";
import { buildRetryGuidance } from "./retry";

export const VERIFY_SUBAGENT_ID = "verify";
export const VERIFY_TASK_DESCRIPTION = "Run local verification";

export interface VerifyRuntimeConfig {
  sandboxMode: "shuru";
  sandboxSettings: SandboxSettings;
  taskRequest: TaskRequest;
  profile: VerifyProjectProfile;
  checkpointCreated?: boolean;
}

export interface PreparedVerifySandbox {
  profile: VerifyProjectProfile;
  sandboxSettings: SandboxSettings;
  checkpoint?: PreparedVerifyCheckpoint;
}

function dedupe(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((v) => v?.trim()).filter((v): v is string => Boolean(v)))];
}

function formatRecipeCommands(title: string, commands: string[]): string {
  return commands.length > 0 ? `- ${title}: ${commands.join(" ; ")}` : `- ${title}: (none inferred)`;
}

function buildProjectContextLines(profile: VerifyProjectProfile): string[] {
  const lines = [`- Detected app type: ${profile.appLabel}.`, `- Recipe ecosystem: ${profile.recipe.ecosystem}.`];
  if (profile.packageManager) {
    lines.push(`- Likely package manager: ${profile.packageManager}.`);
  }
  if (profile.availableScripts.length > 0) {
    lines.push(`- Available package.json scripts: ${profile.availableScripts.join(", ")}.`);
  }
  lines.push(...profile.recipe.evidence.map((evidence) => `- Evidence: ${evidence}.`));
  lines.push(formatRecipeCommands("Shell init", profile.recipe.shellInitCommands));
  lines.push(formatRecipeCommands("Bootstrap commands", profile.recipe.bootstrapCommands));
  lines.push(formatRecipeCommands("Install commands", profile.recipe.installCommands));
  lines.push(formatRecipeCommands("Build commands", profile.recipe.buildCommands));
  lines.push(formatRecipeCommands("Test commands", profile.recipe.testCommands));
  lines.push(`- Start command: ${profile.recipe.startCommand ?? "(none inferred)"}.`);
  if (profile.recipe.smokeTarget) {
    lines.push(`- Smoke target: ${profile.recipe.smokeTarget}.`);
  }
  lines.push(...profile.recipe.notes.map((note) => `- Note: ${note}`));
  return lines;
}

export function buildVerifyTaskPrompt(
  cwd: string,
  settings?: SandboxSettings,
  recipeOverride?: VerifyRecipe | null,
): string {
  const manifest = recipeOverride ? null : loadVerifyEnvironment(cwd, settings);
  const effectiveSettings = manifest?.sandboxSettings ?? settings;
  const profile = inferVerifyProjectProfile(cwd, effectiveSettings, recipeOverride ?? manifest?.recipe ?? null);
  const checkpoint = profile.sandboxSettings.from?.trim();
  const network = profile.sandboxSettings.allowNet
    ? profile.sandboxSettings.allowedHosts?.length
      ? `enabled but restricted to: ${profile.sandboxSettings.allowedHosts.join(", ")}`
      : "enabled"
    : "disabled";

  return [
    "Run a local verification pass for the current workspace.",
    "",
    "Goals:",
    "- Prove the current changes work as well as possible in phase 1.",
    "- First derive and sanity-check a runnable verification recipe from the repository.",
    "- Then execute that recipe inside the active Shuru sandbox and report the result.",
    "",
    "Detected project context and inferred recipe:",
    ...(manifest ? [`- Verify environment manifest: ${manifest.path}.`] : []),
    ...buildProjectContextLines(profile),
    "",
    "Environment:",
    "- Sandbox mode should be Shuru with workspace mounted at /workspace.",
    `- Network is ${network}.`,
    checkpoint
      ? `- Start from the configured Shuru checkpoint: ${checkpoint}.`
      : "- No Shuru checkpoint is configured; use the current sandbox settings as-is.",
    "- Shuru runs are ephemeral in this version. Shell-side workspace edits do not persist back to the host.",
    "",
    "MANDATORY workflow (do ALL steps in order, do NOT stop after build/lint):",
    "",
    "Phase 1 — Setup:",
    "- Probe the sandbox for runtimes (`command -v node`, `command -v npm`, etc). Only install what is missing.",
    "- Ephemeral installs are allowed. Chain install + build in the same sandbox command if no checkpoint provides deps.",
    "",
    "Phase 2 — Build and test:",
    "- Run installCommands, buildCommands, and testCommands from the recipe.",
    "",
    "Phase 3 — Start the app (REQUIRED, do not skip):",
    "- Start the app using startCommand from the recipe, running it in the background.",
    "- Wait for the app to be ready: use a curl readiness loop or `agent-browser wait --load networkidle`.",
    "- If the app fails to start, report the error but still attempt to capture evidence (logs, screenshots).",
    "",
    "Phase 4 — Browser QA testing (REQUIRED, do not skip):",
    "- You are a QA tester. Open the app in the browser and test it like a human would.",
    "- agent-browser commands run on the HOST, not the sandbox. They WILL work. Do not skip them.",
    "- Record a video of the entire browser session.",
    "- Navigate the app: click links, buttons, menus. Verify pages load correctly.",
    "- Check for JavaScript console errors.",
    "- Spend 3-5 interactions testing the critical path. Take screenshots after each.",
    "- This is the most important phase. Build/lint passing means nothing if the app doesn't actually work.",
    "",
    "Phase 5 — Teardown:",
    "- Stop recording, close browser, THEN stop the dev server.",
    ...buildReadinessGuidance(profile),
    ...buildBrowserGuidance(profile),
    ...buildRetryGuidance(profile),
    ...buildEvidenceGuidance(),
    "",
    "Reporting requirements:",
    "- Return a concise structured report with these sections only:",
    "  Summary",
    "  Results",
    "  Evidence",
    "  Blockers",
    "  Residual Risk",
    "- Keep the report compact: prefer 1-3 short bullets per section, and do not paste large command logs unless they are essential blockers.",
    "- The Summary must say what recipe/source of truth you used and whether you changed the inferred/default one.",
    "- Evidence is mandatory even on failure. If you captured screenshots, video, or logs, include their exact workspace-relative file paths in the Evidence section.",
    "- Use markdown links for artifact paths when practical, otherwise include the plain relative paths.",
  ].join("\n");
}

export function createVerifyTaskRequest(
  cwd: string,
  settings?: SandboxSettings,
  recipeOverride?: VerifyRecipe | null,
): TaskRequest {
  return {
    agent: VERIFY_SUBAGENT_ID,
    description: VERIFY_TASK_DESCRIPTION,
    prompt: buildVerifyTaskPrompt(cwd, settings, recipeOverride),
  };
}

export function buildVerifyDetectPrompt(cwd: string, settings?: SandboxSettings): string {
  const manifest = loadVerifyEnvironment(cwd, settings);
  const fallbackProfile = inferVerifyProjectProfile(
    cwd,
    manifest?.sandboxSettings ?? settings,
    manifest?.recipe ?? null,
  );
  return [
    "Inspect this repository and produce a structured verification recipe.",
    "",
    "Your job:",
    "- Read the codebase, config files, and any relevant docs or AGENTS guidance.",
    "- If environment.json or .grok/environment.json exists, treat it as the highest-priority source of truth and only fill in missing details.",
    "- Infer how the project should be installed, built, tested, and started.",
    "- Infer whether verification should use HTTP/browser smoke checks, CLI checks, or no runtime smoke step.",
    "- Prefer concrete commands that are likely to work in a fresh Debian Linux environment.",
    "- Design the recipe so verification probes for runtimes/tools first and only installs missing dependencies or toolchains when necessary.",
    "- Use the fallback hints below only as clues, not as the final answer.",
    "",
    "IMPORTANT for shellInitCommands and bootstrapCommands:",
    "- The sandbox is a fresh Debian Linux VM with almost nothing pre-installed.",
    '- shellInitCommands run before every bash command. Use them for PATH exports (e.g. export PATH="$HOME/.bun/bin:$PATH").',
    "- bootstrapCommands run once during checkpoint creation to install runtimes and tools.",
    "- You MUST include bootstrap commands to install any runtime the project needs (e.g. bun, node, npm, python3, go, cargo, java).",
    "- Example for a Bun + Next.js project: bootstrapCommands should install both bun AND node/npm, since Next.js calls npm internally.",
    '- Example: ["apt-get update && apt-get install -y curl unzip ca-certificates && curl -fsSL https://bun.sh/install | bash", "apt-get install -y nodejs npm"]',
    "",
    "Fallback hints from static detection:",
    ...(manifest ? [`- Detected verify environment manifest: ${manifest.path}.`] : []),
    ...buildProjectContextLines(fallbackProfile),
    "",
    "Return ONLY valid JSON with this exact shape:",
    "{",
    '  "ecosystem": string,',
    '  "appKind": string,',
    '  "appLabel": string,',
    '  "shellInitCommands": string[],',
    '  "bootstrapCommands": string[],',
    '  "installCommands": string[],',
    '  "buildCommands": string[],',
    '  "testCommands": string[],',
    '  "startCommand": string | undefined,',
    '  "startPort": string | undefined,',
    '  "smokeKind": "http" | "cli" | "none",',
    '  "smokeTarget": string | undefined,',
    '  "evidence": string[],',
    '  "notes": string[]',
    "}",
    "",
    "Rules:",
    "- Do not wrap the JSON in markdown.",
    "- Do not include explanatory prose outside the JSON.",
    "- If you are uncertain, put that uncertainty into `notes` and `evidence`.",
  ].join("\n");
}

const NODE_ECOSYSTEMS = new Set(["node", "nodejs", "npm", "bun", "yarn", "pnpm"]);
const PYTHON_ECOSYSTEMS = new Set(["python", "django", "fastapi"]);
const GO_ECOSYSTEMS = new Set(["go", "golang"]);
const RUST_ECOSYSTEMS = new Set(["rust", "cargo"]);

function inferBootstrapFromEcosystem(
  ecosystem: string,
  packageManager: string | null,
): { bootstrap: string[]; shellInit: string[] } {
  const eco = ecosystem.toLowerCase();

  if (
    NODE_ECOSYSTEMS.has(eco) ||
    eco.includes("node") ||
    eco.includes("next") ||
    eco.includes("react") ||
    eco.includes("vite")
  ) {
    const bootstrap = [
      "apt-get update && apt-get install -y curl unzip ca-certificates git python3 make g++ pkg-config nodejs npm",
    ];
    const shellInit = [...defaultShellInit()];
    if (packageManager === "bun") {
      bootstrap.push("curl -fsSL https://bun.sh/install | bash");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
      shellInit.push('export BUN_INSTALL="${HOME}/.bun"');
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
      shellInit.push('export PATH="${BUN_INSTALL}/bin:$PATH"');
    }
    return { bootstrap, shellInit };
  }

  if (PYTHON_ECOSYSTEMS.has(eco) || eco.includes("python") || eco.includes("django") || eco.includes("flask")) {
    return {
      bootstrap: ["apt-get update && apt-get install -y python3 python3-pip python3-venv ca-certificates git"],
      shellInit: defaultShellInit(),
    };
  }

  if (GO_ECOSYSTEMS.has(eco) || eco.includes("go")) {
    return {
      bootstrap: ["apt-get update && apt-get install -y golang ca-certificates git"],
      shellInit: defaultShellInit(),
    };
  }

  if (RUST_ECOSYSTEMS.has(eco) || eco.includes("rust")) {
    return {
      bootstrap: [
        "apt-get update && apt-get install -y curl ca-certificates git build-essential && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y",
      ],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable, not JS template
      shellInit: [...defaultShellInit(), 'export PATH="${HOME}/.cargo/bin:$PATH"'],
    };
  }

  return { bootstrap: [], shellInit: [] };
}

function ensureBootstrapCommands(cwd: string, recipe: VerifyRecipe): VerifyRecipe {
  if (recipe.bootstrapCommands.length > 0) return recipe;
  if (recipe.installCommands.length === 0) return recipe;

  const packageManager = detectPackageManager(cwd);

  const appKind = normalizeVerifyAppKind(recipe.appKind);
  const webBootstrap = getNodeWebBootstrapCommands(packageManager, appKind);
  if (webBootstrap.length > 0) {
    const webShellInit = getNodeWebShellInitCommands(packageManager, appKind);
    return {
      ...recipe,
      bootstrapCommands: webBootstrap,
      shellInitCommands: dedupe([...recipe.shellInitCommands, ...webShellInit]),
    };
  }

  const { bootstrap, shellInit } = inferBootstrapFromEcosystem(recipe.ecosystem, packageManager);
  if (bootstrap.length === 0) return recipe;

  return {
    ...recipe,
    bootstrapCommands: bootstrap,
    shellInitCommands: dedupe([...recipe.shellInitCommands, ...shellInit]),
  };
}

export function createVerifyRuntimeConfig(
  cwd: string,
  baseSettings: SandboxSettings = {},
  recipeOverride?: VerifyRecipe | null,
): VerifyRuntimeConfig {
  const manifest = recipeOverride ? null : loadVerifyEnvironment(cwd, baseSettings);
  const profile = inferVerifyProjectProfile(
    cwd,
    manifest?.sandboxSettings ?? baseSettings,
    recipeOverride ?? manifest?.recipe ?? null,
  );
  profile.recipe = ensureBootstrapCommands(cwd, profile.recipe);
  const sandboxSettings = {
    ...profile.sandboxSettings,
    allowNet: true,
    allowedHosts: undefined,
    allowEphemeralInstall: true,
    hostBrowserCommandsOnHost: true,
  };
  sandboxSettings.shellInit = dedupe([...(sandboxSettings.shellInit ?? []), ...profile.recipe.shellInitCommands]);
  return {
    sandboxMode: "shuru",
    sandboxSettings,
    taskRequest: createVerifyTaskRequest(cwd, sandboxSettings, profile.recipe),
    profile: { ...profile, sandboxSettings },
  };
}

export async function prepareVerifySandbox(
  cwd: string,
  baseSettings: SandboxSettings = {},
  recipeOverride?: VerifyRecipe | null,
  onProgress?: (detail: string) => void,
): Promise<PreparedVerifySandbox> {
  const runtime = createVerifyRuntimeConfig(cwd, baseSettings, recipeOverride);
  onProgress?.("Preparing verify checkpoint");
  const checkpoint = await ensureVerifyCheckpoint(cwd, runtime.profile, runtime.sandboxSettings, onProgress);
  if (checkpoint.checkpointName) {
    runtime.sandboxSettings.from = checkpoint.checkpointName;
    if (checkpoint.guestWorkdir) {
      runtime.sandboxSettings.guestWorkdir = checkpoint.guestWorkdir;
      runtime.sandboxSettings.syncHostWorkspace = true;
    }
    onProgress?.(
      checkpoint.created
        ? `Created verify checkpoint: ${checkpoint.checkpointName}`
        : `Using verify checkpoint: ${checkpoint.checkpointName}`,
    );
  } else {
    onProgress?.("No verify checkpoint needed");
  }
  return {
    profile: runtime.profile,
    sandboxSettings: runtime.sandboxSettings,
    checkpoint,
  };
}

export function buildVerifyPrompt(cwd: string): string {
  const profile = inferVerifyProjectProfile(cwd);
  const recipe = ensureBootstrapCommands(cwd, profile.recipe);
  const draftJson = JSON.stringify(
    {
      recipe: {
        ecosystem: recipe.ecosystem,
        appKind: recipe.appKind,
        appLabel: recipe.appLabel,
        shellInitCommands: recipe.shellInitCommands,
        bootstrapCommands: recipe.bootstrapCommands,
        installCommands: recipe.installCommands,
        buildCommands: recipe.buildCommands,
        testCommands: recipe.testCommands,
        startCommand: recipe.startCommand,
        startPort: recipe.startPort,
        smokeKind: recipe.smokeKind,
        smokeTarget: recipe.smokeTarget,
        evidence: recipe.evidence,
        notes: recipe.notes,
      },
    },
    null,
    2,
  );

  return [
    "Verify this project locally. Follow these steps in order using the `task` tool:",
    "",
    "Step 1: Run the `verify-manifest` sub-agent to create or update `.grok/environment.json`.",
    "- agent: verify-manifest",
    '- description: "Create verify manifest"',
    "- Include this draft manifest JSON directly in the prompt so the sub-agent can refine and write it quickly:",
    "",
    "```json",
    draftJson,
    "```",
    "",
    "- Tell the sub-agent: Review this draft recipe against package.json and key config files. Adjust if needed, then write .grok/environment.json. If the draft looks correct, write it as-is. Do not over-research.",
    "- IMPORTANT: The Shuru sandbox is Debian 13 trixie on aarch64 (ARM64) with NOTHING pre-installed. bootstrapCommands MUST install every runtime from scratch (e.g. nodejs, npm, python3, go, cargo).",
    "",
    "Step 2: After the manifest is written, run the `verify` sub-agent.",
    "- agent: verify",
    '- description: "Run local verification"',
    "- Tell it to use `.grok/environment.json` as the source of truth.",
    "- Include these execution instructions:",
    "  - Runs inside a Shuru sandbox (Debian 13 trixie, aarch64/ARM64) with full network access.",
    "  - The sandbox has NOTHING pre-installed unless bootstrapCommands in the manifest already ran during checkpoint creation.",
    "  - Ephemeral installs allowed.",
    "  - Probe for runtimes first (`command -v node`, etc), only install what is missing.",
    "  - agent-browser runs on the HOST, not the sandbox. It WILL work.",
    "  - If recipe has startCommand + startPort, start app in background and run browser smoke tests.",
    "  - Use `agent-browser record start .grok/verify-artifacts/verify-smoke.webm` before opening the page.",
    "  - Use `agent-browser --screenshot-dir .grok/verify-artifacts screenshot` after the page loads.",
    "  - CRITICAL: Stop the recording (`agent-browser record stop`) and close the browser (`agent-browser close`) BEFORE stopping the dev server. The server must stay alive until all browser commands finish.",
    "  - Return a concise report: Summary, Results, Evidence (mandatory), Blockers, Residual Risk.",
    "",
    "Important:",
    "- Do NOT perform verification work yourself. Delegate each step via `task`.",
    "- Run step 1 first, then step 2.",
    "- After step 2, relay the verification report to the user.",
  ].join("\n");
}

export const VERIFY_PROMPT = "__DYNAMIC__";

export function getVerifyCliError(options: { hasPrompt?: boolean; hasMessageArgs?: boolean }): string | null {
  if (options.hasPrompt) {
    return "Cannot combine --verify with --prompt.";
  }

  if (options.hasMessageArgs) {
    return "Cannot combine --verify with an opening message.";
  }

  return null;
}

export {
  defaultShellInit,
  inferVerifyProjectProfile,
  inferVerifySmokeUrl,
  normalizeVerifyRecipe,
  type VerifyProjectProfile,
} from "./recipes";
