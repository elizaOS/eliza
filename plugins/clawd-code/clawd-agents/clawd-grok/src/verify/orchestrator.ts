import type { TaskRequest, ToolResult, VerifyRecipe } from "../types/index";
import type { SandboxSettings } from "../utils/settings";
import { ensureVerifyCheckpoint, type PreparedVerifyCheckpoint } from "./checkpoint";
import { buildVerifyTaskPrompt } from "./entrypoint";
import { loadVerifyEnvironment, saveVerifyEnvironment } from "./environment";
import { inferVerifyProjectProfile, type VerifyProjectProfile } from "./recipes";

export interface VerifyAgentLike {
  getCwd(): string;
  getSandboxSettings(): SandboxSettings;
  setSandboxSettings(settings: SandboxSettings): void;
  detectVerifyRecipe(settings?: SandboxSettings, abortSignal?: AbortSignal): Promise<VerifyRecipe | null>;
  runTaskRequest(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult>;
}

export interface PreparedVerifyRun {
  profile: VerifyProjectProfile;
  sandboxSettings: SandboxSettings;
  taskRequest: TaskRequest;
  checkpoint?: PreparedVerifyCheckpoint;
  manifestPath?: string;
  usedVerifyDetect: boolean;
}

export interface VerifyOrchestratorOptions {
  onProgress?: (detail: string) => void;
  abortSignal?: AbortSignal;
}

function buildRuntimeSandboxSettings(profile: VerifyProjectProfile): SandboxSettings {
  return {
    ...profile.sandboxSettings,
    allowNet: true,
    allowedHosts: undefined,
    allowEphemeralInstall: true,
    hostBrowserCommandsOnHost: true,
    shellInit: [...new Set([...(profile.sandboxSettings.shellInit ?? []), ...profile.recipe.shellInitCommands])],
  };
}

export async function prepareVerifyRun(
  agent: VerifyAgentLike,
  options: VerifyOrchestratorOptions = {},
): Promise<PreparedVerifyRun> {
  const cwd = agent.getCwd();
  const baseSettings = agent.getSandboxSettings();
  const manifest = loadVerifyEnvironment(cwd, baseSettings);

  if (manifest) {
    options.onProgress?.(`Loaded verify environment manifest: ${manifest.path}`);
  } else {
    options.onProgress?.("No verify environment manifest found; running verify-detect to generate one");
  }

  let profile = inferVerifyProjectProfile(cwd, manifest?.sandboxSettings ?? baseSettings, manifest?.recipe ?? null);
  let usedVerifyDetect = false;
  let manifestPath = manifest?.path;

  if (!manifest) {
    const detectedRecipe = await agent.detectVerifyRecipe(baseSettings, options.abortSignal);
    if (detectedRecipe) {
      usedVerifyDetect = true;
      profile = inferVerifyProjectProfile(cwd, baseSettings, detectedRecipe);
      options.onProgress?.(`verify-detect selected recipe for ${profile.appLabel}`);
      manifestPath = saveVerifyEnvironment(cwd, profile.recipe, profile.sandboxSettings);
      options.onProgress?.(`Created verify environment manifest: ${manifestPath}`);
    } else {
      options.onProgress?.(
        "verify-detect did not return a usable recipe; keeping deterministic fallback without writing a manifest",
      );
    }
  }

  const sandboxSettings = buildRuntimeSandboxSettings(profile);
  options.onProgress?.("Preparing verify checkpoint");
  const checkpoint = await ensureVerifyCheckpoint(cwd, profile, sandboxSettings);
  if (checkpoint.checkpointName) {
    sandboxSettings.from = checkpoint.checkpointName;
    if (checkpoint.guestWorkdir) {
      sandboxSettings.guestWorkdir = checkpoint.guestWorkdir;
      sandboxSettings.syncHostWorkspace = true;
    }
    options.onProgress?.(
      checkpoint.created
        ? `Created verify checkpoint: ${checkpoint.checkpointName}`
        : `Using verify checkpoint: ${checkpoint.checkpointName}`,
    );
  } else {
    options.onProgress?.("No verify checkpoint needed for this recipe");
  }

  const taskRequest: TaskRequest = {
    agent: "verify",
    description: "Run local verification",
    prompt: buildVerifyTaskPrompt(cwd, sandboxSettings, profile.recipe),
  };

  return {
    profile,
    sandboxSettings,
    taskRequest,
    checkpoint,
    manifestPath,
    usedVerifyDetect,
  };
}

export async function runVerifyOrchestration(
  agent: VerifyAgentLike,
  options: VerifyOrchestratorOptions = {},
): Promise<ToolResult> {
  const originalSandboxSettings = agent.getSandboxSettings();
  const prepared = await prepareVerifyRun(agent, options);
  agent.setSandboxSettings(prepared.sandboxSettings);
  try {
    options.onProgress?.("Running verify sub-agent");
    const result = await agent.runTaskRequest(prepared.taskRequest, options.onProgress, options.abortSignal);
    return {
      ...result,
      verifyRecipe: prepared.profile.recipe,
    };
  } finally {
    agent.setSandboxSettings(originalSandboxSettings);
  }
}
