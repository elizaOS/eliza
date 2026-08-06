import type { VerifyRetryStrategy } from "../types/index";
import type { VerifyProjectProfile } from "./recipes";

const NODE_WEB_APP_KINDS = new Set(["nextjs", "vite", "astro", "sveltekit", "remix", "cra"]);

function buildNativeModuleRetry(profile: VerifyProjectProfile): VerifyRetryStrategy | null {
  if (!NODE_WEB_APP_KINDS.has(profile.appKind)) {
    return null;
  }

  const installCommand =
    profile.packageManager === "bun"
      ? "npm install --include=optional"
      : profile.packageManager === "pnpm"
        ? "pnpm install"
        : profile.packageManager === "yarn"
          ? "yarn install"
          : "npm install --include=optional";

  return {
    id: "native-module-retry",
    when: "Only if install or build fails with missing native bindings such as lightningcss, sharp, @next/swc, esbuild, rollup, or a missing *.linux-*.node module.",
    reason: "Recover from platform-specific optional/native dependency installs without unbounded retry loops.",
    commands: ["rm -rf node_modules", installCommand, ...profile.recipe.buildCommands],
  };
}

function buildStartupRetry(profile: VerifyProjectProfile): VerifyRetryStrategy | null {
  if (profile.recipe.smokeKind !== "http" || !profile.recipe.startCommand || !profile.recipe.startPort) {
    return null;
  }
  return {
    id: "startup-readiness-retry",
    when: "Only if the app starts but never becomes reachable at the expected localhost URL.",
    reason: "Give one deterministic retry with explicit host/port binding before declaring the app non-runnable.",
    commands: [`HOST=0.0.0.0 PORT=${profile.recipe.startPort} ${profile.recipe.startCommand}`],
  };
}

export function getVerifyRetryStrategies(profile: VerifyProjectProfile): VerifyRetryStrategy[] {
  return [buildNativeModuleRetry(profile), buildStartupRetry(profile)].filter(
    (strategy): strategy is VerifyRetryStrategy => Boolean(strategy),
  );
}

export function buildRetryGuidance(profile: VerifyProjectProfile): string[] {
  const strategies = getVerifyRetryStrategies(profile);
  if (strategies.length === 0) {
    return [
      "- Do not thrash. If a failure is not covered by a known retry strategy, report it directly instead of guessing.",
    ];
  }

  return [
    "- Retry policy: at most one bounded retry per known failure class. Do not loop or improvise multiple package-manager swaps.",
    ...strategies.flatMap((strategy) => [
      `- Retry strategy (${strategy.id}): ${strategy.when}`,
      `- Reason: ${strategy.reason}`,
      `- Commands: ${strategy.commands.join(" && ")}`,
    ]),
  ];
}
