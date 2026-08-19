#!/usr/bin/env node
/**
 * Derives immutable cross-store version and channel identities from the
 * canonical npm release transaction without contacting publisher services.
 */

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+)(?:\.(0|[1-9]\d*))?)?$/;

const CHANNEL_OFFSETS = Object.freeze({
  alpha: 1000,
  beta: 3000,
  rc: 5000,
  nightly: 7000,
});

const EXTENSION_CHANNEL_OFFSETS = Object.freeze({
  nightly: 10000,
  alpha: 20000,
  beta: 40000,
  rc: 50000,
});

function requireArgument(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1];
}

export function parseStoreSemver(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(
      `Store release version must be canonical semver with at most one numeric prerelease component: ${version}`,
    );
  }
  const [, majorRaw, minorRaw, patchRaw, prerelease = "", sequenceRaw = "0"] =
    match;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  const sequence = Number(sequenceRaw);
  if (sequence > 999) {
    throw new Error(
      `Store prerelease sequence must not exceed 999: ${version}`,
    );
  }
  return { major, minor, patch, prerelease, sequence };
}

function numericBuild({ major, minor, patch, prerelease, sequence }) {
  if (major > 20 || minor > 99 || patch > 99) {
    throw new Error(
      "Store release version exceeds the Android versionCode allocation (major <= 20, minor/patch <= 99)",
    );
  }
  const offset = prerelease ? (CHANNEL_OFFSETS[prerelease] ?? 8000) : 9000;
  const value =
    major * 100000000 + minor * 1000000 + patch * 10000 + offset + sequence;
  if (value > 2100000000) {
    throw new Error(`Android versionCode ${value} exceeds the Play limit`);
  }
  return value;
}

function extensionVersion(parsed) {
  const { major, minor, patch, prerelease, sequence } = parsed;
  if ([major, minor, patch].some((value) => value > 65535)) {
    throw new Error(
      "Browser extension version components must not exceed 65535",
    );
  }
  if (prerelease && !(prerelease in EXTENSION_CHANNEL_OFFSETS)) {
    throw new Error(
      `Unsupported browser extension prerelease lane: ${prerelease}`,
    );
  }
  const fourth = prerelease
    ? (EXTENSION_CHANNEL_OFFSETS[prerelease] ?? 50000) + sequence
    : 60000;
  if (fourth > 65535) {
    throw new Error(
      `Browser extension build component ${fourth} exceeds 65535`,
    );
  }
  return `${major}.${minor}.${patch}.${fourth}`;
}

export function createStoreReleasePlan({ version, channel, sourceSha }) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error(
      `Store release source SHA must be 40 lowercase hex characters: ${sourceSha}`,
    );
  }
  if (channel !== "beta" && channel !== "latest") {
    throw new Error(`Store release channel must be beta or latest: ${channel}`);
  }
  const parsed = parseStoreSemver(version);
  const stable = !parsed.prerelease;
  if ((channel === "latest") !== stable) {
    throw new Error(
      `Store release channel ${channel} does not match ${stable ? "stable" : "prerelease"} version ${version}`,
    );
  }
  const buildNumber = numericBuild(parsed);
  return Object.freeze({
    source_sha: sourceSha,
    version,
    tag: `v${version}`,
    channel,
    stable,
    android_version_code: String(buildNumber),
    android_track: stable ? "production" : "internal",
    amazon_track: stable ? "production" : "testing",
    samsung_track: stable ? "production" : "beta",
    solana_track: stable ? "production" : "review",
    ios_marketing_version: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
    ios_build_number: String(buildNumber),
    apple_lane: stable ? "release" : "beta",
    windows_package_version: `${parsed.major}.${parsed.minor}.${parsed.patch}.0`,
    windows_publish: stable,
    snap_channel: stable ? "stable" : "beta",
    extension_version: extensionVersion(parsed),
    chrome_publish_target: stable ? "default" : "trustedTesters",
    firefox_channel: "listed",
    flathub_branch: stable ? "stable" : "beta",
  });
}

function writeGitHubOutputs(filePath, plan) {
  const lines = Object.entries(plan).map(([name, value]) => {
    if (!["string", "boolean"].includes(typeof value)) {
      throw new Error(`Store release output ${name} must be scalar`);
    }
    return `${name}=${value}`;
  });
  appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

export function main(args = process.argv.slice(2)) {
  const plan = createStoreReleasePlan({
    version: requireArgument(args, "--version"),
    channel: requireArgument(args, "--channel"),
    sourceSha: requireArgument(args, "--source-sha"),
  });
  const outputIndex = args.indexOf("--github-output");
  if (outputIndex >= 0) {
    if (!args[outputIndex + 1])
      throw new Error("--github-output requires a path");
    writeGitHubOutputs(args[outputIndex + 1], plan);
  }
  console.log(`${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // error-policy:J1 command boundary reports invalid release identity
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
