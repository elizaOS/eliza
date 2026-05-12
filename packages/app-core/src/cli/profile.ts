import os from "node:os";
import path from "node:path";
import { isValidProfileName } from "./profile-utils";

export type CliProfileParseResult =
  | { ok: true; profile: string | null; argv: string[] }
  | { ok: false; error: string };

function takeValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  if (raw.includes("=")) {
    const [, value] = raw.split("=", 2);
    const trimmed = (value ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const trimmed = (next ?? "").trim();
  return { value: trimmed || null, consumedNext: Boolean(next) };
}

export function parseCliProfileArgs(argv: string[]): CliProfileParseResult {
  if (argv.length < 2) {
    return { ok: true, profile: null, argv };
  }

  const out: string[] = argv.slice(0, 2);
  let profile: string | null = null;
  let sawDev = false;
  let sawCommand = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }

    if (sawCommand) {
      out.push(arg);
      continue;
    }

    if (arg === "--dev") {
      if (profile && profile !== "dev") {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      sawDev = true;
      profile = "dev";
      continue;
    }

    if (arg === "--profile" || arg.startsWith("--profile=")) {
      if (sawDev) {
        return { ok: false, error: "Cannot combine --dev with --profile" };
      }
      const next = args[i + 1];
      const { value, consumedNext } = takeValue(arg, next);
      if (consumedNext) {
        i += 1;
      }
      if (!value) {
        return { ok: false, error: "--profile requires a value" };
      }
      if (!isValidProfileName(value)) {
        return {
          ok: false,
          error: 'Invalid --profile (use letters, numbers, "_", "-" only)',
        };
      }
      profile = value;
      continue;
    }

    if (!arg.startsWith("-")) {
      sawCommand = true;
      out.push(arg);
      continue;
    }

    out.push(arg);
  }

  return { ok: true, profile, argv: out };
}

function resolveProfileStateDir(
  profile: string,
  namespace: string,
  homedir: () => string,
): string {
  const suffix = profile.toLowerCase() === "default" ? "" : `-${profile}`;
  return path.join(homedir(), `.${namespace}${suffix}`);
}

export function applyCliProfileEnv(params: {
  profile: string;
  env?: Record<string, string | undefined>;
  homedir?: () => string;
}) {
  const env = params.env ?? (process.env as Record<string, string | undefined>);
  const homedir = params.homedir ?? os.homedir;
  const profile = params.profile.trim();
  if (!profile) {
    return;
  }

  // Convenience only: fill defaults, never override explicit env values.
  env.ELIZA_PROFILE = profile;
  const namespace = env.ELIZA_NAMESPACE?.trim() || "eliza";
  env.ELIZA_NAMESPACE = namespace;

  if (!env.MILADY_STATE_DIR?.trim() && !env.ELIZA_STATE_DIR?.trim()) {
    env.ELIZA_STATE_DIR = resolveProfileStateDir(profile, namespace, homedir);
  }

  const stateDir =
    env.MILADY_STATE_DIR?.trim() || env.ELIZA_STATE_DIR?.trim() || "";
  if (!env.ELIZA_CONFIG_PATH?.trim() && stateDir) {
    env.ELIZA_CONFIG_PATH = path.join(stateDir, `${namespace}.json`);
  }

  if (profile === "dev" && !env.ELIZA_GATEWAY_PORT?.trim()) {
    env.ELIZA_GATEWAY_PORT = "19001";
  }
}
