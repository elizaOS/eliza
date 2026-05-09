import { isRich, theme } from "/shared";
import { resolveCommitHash } from "./git-commit";

type BannerOptions = {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  commit?: string | null;
  richTty?: boolean;
};

let bannerEmitted = false;

export function formatCliBannerLine(
  version: string,
  options: BannerOptions = {},
): string {
  const commit = options.commit ?? resolveCommitHash({ env: options.env });
  const commitLabel = commit ?? "unknown";
  const rich = options.richTty ?? isRich();
  const title =
    (options.env?.APP_CLI_NAME ?? "eliza").charAt(0).toUpperCase() +
    (options.env?.APP_CLI_NAME ?? "eliza").slice(1);
  if (rich) {
    return `${theme.heading(title)} ${theme.info(version)} ${theme.muted(`(${commitLabel})`)}`;
  }
  return `${title} ${version} (${commitLabel})`;
}

export function emitCliBanner(version: string, options: BannerOptions = {}) {
  if (bannerEmitted) {
    return;
  }
  const argv = options.argv ?? process.argv;
  if (!process.stdout.isTTY) {
    return;
  }
  if (argv.some((a) => a === "--json" || a.startsWith("--json="))) {
    return;
  }
  if (argv.some((a) => a === "--version" || a === "-V" || a === "-v")) {
    return;
  }
  const _rich = options.richTty ?? isRich();
  const line = formatCliBannerLine(version, options);
  process.stdout.write(`${line}\n\n`);
  bannerEmitted = true;
}

export function hasEmittedCliBanner(): boolean {
  return bannerEmitted;
}
