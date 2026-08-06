import * as fs from "fs";
import * as path from "path";
import type { VerifyEnvironmentManifest, VerifyRecipe } from "../types/index";
import { mergeSandboxSettings, normalizeSandboxSettings, type SandboxSettings } from "../utils/settings";
import { normalizeVerifyRecipe } from "./recipes";

export interface LoadedVerifyEnvironment {
  path: string;
  recipe: VerifyRecipe;
  sandboxSettings: SandboxSettings;
}

const VERIFY_ENVIRONMENT_FILES = [".grok/environment.json", ".clawd/environment.json", "environment.json"];
const GENERATED_VERIFY_ENVIRONMENT = ".grok/environment.json";

function readJson(filePath: string): VerifyEnvironmentManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as VerifyEnvironmentManifest;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}

function normalizeManifestRecipe(raw: VerifyEnvironmentManifest): VerifyRecipe | null {
  const base = raw.recipe && typeof raw.recipe === "object" ? raw.recipe : raw;
  return normalizeVerifyRecipe({
    ecosystem: base.ecosystem ?? raw.ecosystem ?? "custom",
    appKind: base.appKind ?? raw.appKind ?? "unknown",
    appLabel: base.appLabel ?? raw.appLabel ?? "Custom verify environment",
    shellInitCommands: base.shellInitCommands ?? base.shellInit ?? raw.shellInitCommands ?? raw.shellInit ?? [],
    bootstrapCommands: base.bootstrapCommands ?? base.bootstrap ?? raw.bootstrapCommands ?? raw.bootstrap ?? [],
    installCommands: base.installCommands ?? base.install ?? raw.installCommands ?? raw.install ?? [],
    buildCommands: base.buildCommands ?? base.build ?? raw.buildCommands ?? raw.build ?? [],
    testCommands: base.testCommands ?? base.test ?? raw.testCommands ?? raw.test ?? [],
    startCommand: base.startCommand ?? base.start ?? raw.startCommand ?? raw.start,
    startPort: base.startPort ?? raw.startPort,
    smokeKind: base.smokeKind ?? raw.smokeKind ?? "none",
    smokeTarget: base.smokeTarget ?? raw.smokeTarget,
    evidence: asStringArray(base.evidence ?? raw.evidence),
    notes: asStringArray(base.notes ?? raw.notes),
  });
}

export function loadVerifyEnvironment(cwd: string, baseSettings: SandboxSettings = {}): LoadedVerifyEnvironment | null {
  for (const candidate of VERIFY_ENVIRONMENT_FILES) {
    const filePath = path.join(cwd, candidate);
    if (!fs.existsSync(filePath)) continue;
    const manifest = readJson(filePath);
    if (!manifest) continue;
    const recipe = normalizeManifestRecipe(manifest);
    if (!recipe) continue;
    const sandboxSettings = mergeSandboxSettings(baseSettings, normalizeSandboxSettings(manifest.sandbox));
    return {
      path: filePath,
      recipe,
      sandboxSettings,
    };
  }
  return null;
}

function pickPersistentSandboxSettings(settings: SandboxSettings): SandboxSettings {
  const persistent: SandboxSettings = {};
  if (settings.allowNet !== undefined) persistent.allowNet = settings.allowNet;
  if (settings.allowedHosts?.length) persistent.allowedHosts = settings.allowedHosts;
  if (settings.ports?.length) persistent.ports = settings.ports;
  if (settings.cpus) persistent.cpus = settings.cpus;
  if (settings.memory) persistent.memory = settings.memory;
  if (settings.diskSize) persistent.diskSize = settings.diskSize;
  if (settings.secrets?.length) persistent.secrets = settings.secrets;
  if (settings.from) persistent.from = settings.from;
  if (settings.verifyBaseFrom) persistent.verifyBaseFrom = settings.verifyBaseFrom;
  if (settings.guestWorkdir) persistent.guestWorkdir = settings.guestWorkdir;
  if (settings.syncHostWorkspace !== undefined) persistent.syncHostWorkspace = settings.syncHostWorkspace;
  if (settings.shellInit?.length) persistent.shellInit = settings.shellInit;
  return persistent;
}

export function saveVerifyEnvironment(
  cwd: string,
  recipe: VerifyRecipe,
  sandboxSettings: SandboxSettings = {},
): string {
  const filePath = path.join(cwd, GENERATED_VERIFY_ENVIRONMENT);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload: VerifyEnvironmentManifest = {
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
    sandbox: pickPersistentSandboxSettings(sandboxSettings),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}
