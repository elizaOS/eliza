/**
 * `eliza update` — check for and install updates.
 *
 *   eliza update                   # Check & update on current channel
 *   eliza update --channel beta    # Switch to beta and update
 *   eliza update --check           # Check only, don't install
 *   eliza update --voice-models    # Also check voice sub-model updates
 *   eliza update status            # Show versions across all channels
 *   eliza update channel [name]    # View or change release channel
 *
 * `--voice-models` runs the R5-versioning voice-sub-model auto-updater
 * (separate from the npm-registry update for the elizaos package itself).
 * On a headless TTY-less environment the voice-model updater is the ONLY
 * place auto-updates fire — the runtime tick is suppressed (R5 §4.5).
 */

import type { ReleaseChannel } from "@elizaos/agent";
import { theme } from "@elizaos/shared";
import type { Command } from "commander";
import { CLI_VERSION } from "../version";

const ALL_CHANNELS: readonly ReleaseChannel[] = ["stable", "beta", "nightly"];

const CHANNEL_LABELS: Record<ReleaseChannel, (s: string) => string> = {
  stable: theme.success,
  beta: theme.warn,
  nightly: theme.accent,
};

const CHANNEL_DESCRIPTIONS: Record<ReleaseChannel, string> = {
  stable: "Production-ready releases. Recommended for most users.",
  beta: "Release candidates. May contain minor issues.",
  nightly: "Latest development builds. May be unstable.",
};

function channelLabel(ch: ReleaseChannel): string {
  return CHANNEL_LABELS[ch](ch);
}

function parseChannelOrExit(raw: string): ReleaseChannel {
  if (ALL_CHANNELS.includes(raw as ReleaseChannel)) {
    return raw as ReleaseChannel;
  }
  console.error(
    theme.error(
      `Invalid channel "${raw}". Valid channels: ${ALL_CHANNELS.join(", ")}`,
    ),
  );
  process.exit(1);
}

async function voiceModelsAction(opts: {
  check?: boolean;
  force?: boolean;
}): Promise<void> {
  const { VOICE_MODEL_VERSIONS, latestVoiceModelVersion } = await import(
    "@elizaos/shared"
  );

  console.log(`\n${theme.heading("Eliza voice sub-models")}\n`);
  console.log(
    theme.muted(
      "Per-sub-model versioning (R5-versioning §3). Auto-update gate: newer\n" +
        "semver + publish-gate netImprovement + bundle compatibility. Pinned\n" +
        "ids decline. See models/voice/CHANGELOG.md for the human history.\n",
    ),
  );

  const seenIds = new Set<string>();
  for (const v of VOICE_MODEL_VERSIONS) {
    if (seenIds.has(v.id)) continue;
    seenIds.add(v.id);
    const latest = latestVoiceModelVersion(v.id);
    if (!latest) continue;
    const sizeMb =
      latest.ggufAssets.length === 0
        ? "(unpublished)"
        : `${(latest.ggufAssets.reduce((s, a) => s + a.sizeBytes, 0) / 1_048_576).toFixed(1)} MB`;
    console.log(
      `  ${theme.accent(v.id.padEnd(24))} ${theme.success(latest.version.padEnd(8))} ${theme.muted(sizeMb)}`,
    );
    if (latest.changelogEntry) {
      console.log(theme.muted(`    ${latest.changelogEntry}`));
    }
  }

  if (opts.check) {
    console.log(
      theme.muted(
        "\n  Run `eliza update --voice-models` without `--check` to apply updates.\n",
      ),
    );
    return;
  }

  console.log(
    theme.muted(
      "\n  Live update path runs in the runtime (VoiceModelUpdater service)\n" +
        "  with per-platform NetworkPolicy gating. CLI applies are headless-only.\n",
    ),
  );
}

async function updateAction(opts: {
  channel?: string;
  check?: boolean;
  force?: boolean;
  voiceModels?: boolean;
}): Promise<void> {
  if (opts.voiceModels) {
    return voiceModelsAction({ check: opts.check, force: opts.force });
  }
  const { loadElizaConfig, saveElizaConfig } = await import("@elizaos/agent");
  const { checkForUpdate, resolveChannel } = await import("@elizaos/agent");
  const { detectInstallMethod, getUpdateActionPlan, performUpdate } =
    await import("@elizaos/agent");
  const config = loadElizaConfig();
  let newChannel: ReleaseChannel | undefined;

  if (opts.channel) {
    newChannel = parseChannelOrExit(opts.channel);
    const oldChannel = resolveChannel(config.update);

    if (newChannel !== oldChannel) {
      saveElizaConfig({
        ...config,
        update: {
          ...config.update,
          channel: newChannel,
          lastCheckAt: undefined,
          lastCheckVersion: undefined,
        },
      });
      console.log(
        `\nRelease channel changed: ${channelLabel(oldChannel)} -> ${channelLabel(newChannel)}`,
      );
      console.log(theme.muted(`  ${CHANNEL_DESCRIPTIONS[newChannel]}\n`));
    }
  }

  const effectiveChannel = newChannel ?? resolveChannel(config.update);

  console.log(
    `\n${theme.heading("Eliza Update")}  ${theme.muted(`(channel: ${effectiveChannel})`)}`,
  );
  console.log(theme.muted(`Current version: ${CLI_VERSION}\n`));
  console.log("Checking for updates...\n");

  const result = await checkForUpdate({ force: opts.force ?? !!newChannel });

  if (result.error) {
    console.error(theme.warn(`  ${result.error}\n`));
    if (!opts.check) process.exit(1);
    return;
  }

  if (!result.updateAvailable) {
    console.log(
      theme.success(
        `  Already up to date! (${CLI_VERSION} is the latest on ${effectiveChannel})\n`,
      ),
    );
    return;
  }

  console.log(
    `  ${theme.accent("Update available:")} ${CLI_VERSION} -> ${theme.success(result.latestVersion ?? "unknown")}`,
  );
  console.log(
    theme.muted(
      `  Channel: ${effectiveChannel} | dist-tag: ${result.distTag}\n`,
    ),
  );

  if (opts.check) {
    console.log(theme.muted("  Run `eliza update` to install the update.\n"));
    return;
  }

  const method = detectInstallMethod();
  const updatePlan = getUpdateActionPlan(method, effectiveChannel);
  if (!updatePlan.canExecuteFromContext) {
    console.log(theme.warn(`  ${updatePlan.message}\n`));
    return;
  }

  console.log(theme.muted(`  Install method: ${method}`));
  console.log(theme.muted(`  Authority: ${updatePlan.authority}`));
  if (updatePlan.command) {
    console.log(theme.muted(`  Command: ${updatePlan.command}`));
  }
  console.log("  Installing update...\n");

  const updateResult = await performUpdate(
    CLI_VERSION,
    effectiveChannel,
    method,
  );

  if (!updateResult.success) {
    console.error(theme.error(`\n  Update failed: ${updateResult.error}\n`));
    console.log(
      theme.muted(
        `  Command: ${updateResult.command}\n  You can try running it manually.\n`,
      ),
    );
    process.exit(1);
  }

  if (updateResult.newVersion) {
    console.log(
      theme.success(
        `\n  Updated successfully! ${CLI_VERSION} -> ${updateResult.newVersion}`,
      ),
    );
  } else {
    console.log(theme.success("\n  Update command completed successfully."));
    console.log(
      theme.warn(
        `  Could not verify the new version. Expected: ${result.latestVersion ?? "unknown"}`,
      ),
    );
  }
  console.log(
    theme.muted("  Restart eliza for the new version to take effect.\n"),
  );
}

async function statusAction(): Promise<void> {
  const { loadElizaConfig } = await import("@elizaos/agent");
  const { resolveChannel, fetchAllChannelVersions } = await import(
    "@elizaos/agent"
  );
  const { detectInstallMethod, getUpdateActionPlan } = await import(
    "@elizaos/agent"
  );
  console.log(`\n${theme.heading("Version Status")}\n`);

  const config = loadElizaConfig();
  const channel = resolveChannel(config.update);

  console.log(`  Installed:  ${theme.accent(CLI_VERSION)}`);
  console.log(`  Channel:    ${channelLabel(channel)}`);
  const method = detectInstallMethod();
  const updatePlan = getUpdateActionPlan(method, channel);

  console.log(`  Install:    ${theme.muted(method)}`);
  console.log(`  Authority:  ${theme.muted(updatePlan.authority)}`);
  console.log(`  Next:       ${theme.muted(updatePlan.nextAction)}`);
  if (updatePlan.command) {
    console.log(`  Command:    ${theme.muted(updatePlan.command)}`);
  }
  console.log(
    `  Can run:    ${updatePlan.canExecuteFromContext ? "yes" : "no"}`,
  );

  console.log(`\n${theme.heading("Available Versions")}\n`);
  console.log("  Fetching from npm registry...\n");

  const versions = await fetchAllChannelVersions();

  for (const ch of ALL_CHANNELS) {
    const ver = versions[ch] ?? theme.muted("(not published)");
    const marker = ch === channel ? theme.accent(" <-- current") : "";
    console.log(`  ${channelLabel(ch).padEnd(22)} ${ver}${marker}`);
  }

  if (config.update?.lastCheckAt) {
    console.log(
      `\n  ${theme.muted(`Last checked: ${new Date(config.update.lastCheckAt).toLocaleString()}`)}`,
    );
  }
  console.log();
}

async function channelAction(channelArg: string | undefined): Promise<void> {
  const { loadElizaConfig, saveElizaConfig } = await import("@elizaos/agent");
  const { resolveChannel } = await import("@elizaos/agent");
  const config = loadElizaConfig();
  const current = resolveChannel(config.update);

  if (!channelArg) {
    console.log(`\n${theme.heading("Release Channel")}\n`);
    console.log(`  Current: ${channelLabel(current)}`);
    console.log(theme.muted(`  ${CHANNEL_DESCRIPTIONS[current]}\n`));
    console.log("  Available channels:");
    for (const ch of ALL_CHANNELS) {
      const marker = ch === current ? theme.accent(" (active)") : "";
      console.log(
        `    ${channelLabel(ch)}${marker}  ${theme.muted(CHANNEL_DESCRIPTIONS[ch])}`,
      );
    }
    console.log(
      `\n  ${theme.muted("Switch with: eliza update channel <stable|beta|nightly>")}\n`,
    );
    return;
  }

  const newChannel = parseChannelOrExit(channelArg);

  if (newChannel === current) {
    console.log(
      `\n  Already on ${channelLabel(current)} channel. No change needed.\n`,
    );
    return;
  }

  saveElizaConfig({
    ...config,
    update: {
      ...config.update,
      channel: newChannel,
      lastCheckAt: undefined,
      lastCheckVersion: undefined,
    },
  });

  console.log(
    `\n  Channel changed: ${channelLabel(current)} -> ${channelLabel(newChannel)}`,
  );
  console.log(theme.muted(`  ${CHANNEL_DESCRIPTIONS[newChannel]}`));
  console.log(
    `\n  ${theme.muted("Run `eliza update` to fetch the latest version from this channel.")}\n`,
  );
}

export function registerUpdateCommand(program: Command): void {
  const updateCmd = program
    .command("update")
    .description("Check for and install updates")
    .option(
      "-c, --channel <channel>",
      "Switch release channel (stable, beta, nightly)",
    )
    .option("--check", "Check for updates without installing")
    .option("--force", "Force update check (bypass interval cache)")
    .option(
      "--voice-models",
      "List voice sub-model versions (R5-versioning auto-updater)",
    )
    .action(updateAction);

  updateCmd
    .command("status")
    .description(
      "Show current version and available updates across all channels",
    )
    .action(statusAction);

  updateCmd
    .command("channel [channel]")
    .description("View or change the release channel")
    .action(channelAction);
}
