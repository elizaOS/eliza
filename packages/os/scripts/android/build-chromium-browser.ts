#!/usr/bin/env node
/** Owned Android Chromium compilation. Signing, AOSP admission and boot qualification remain separate. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareChromiumBrowser } from "./prepare-chromium-browser.ts";

const ANDROID_PACKAGE = /^"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+"$/;

/**
 * The reviewed Chromium targets. `chrome_public_apk` is the owned Desktop Android browser.
 * `system_webview_apk` is a WebView provider: it carries no browser component, and its GN
 * arguments must name the provider package once (system_webview_package_name).
 */
const targets = {
  chrome_public_apk: {
    reviewed: (assignment) =>
      assignment("is_desktop_android") === "true" &&
      assignment("chrome_public_manifest_package") === '"ai.elizaos.chromium"',
    refusal:
      "GN arguments must select the reviewed owned Desktop Android browser",
    apks: ["apks/ChromePublic.apk"],
  },
  system_webview_apk: {
    reviewed: (assignment) =>
      ANDROID_PACKAGE.test(assignment("system_webview_package_name")),
    refusal: "GN arguments must name the reviewed Android WebView provider",
    // A 64-bit-only build names its provider SystemWebView64.apk.
    apks: ["apks/SystemWebView.apk", "apks/SystemWebView64.apk"],
  },
};

export function chromiumBuildPlan({
  source,
  build,
  gnArgs,
  jobs = 8,
  target = "chrome_public_apk",
}) {
  if (!path.isAbsolute(source) || !path.isAbsolute(build))
    throw new Error("source and build must be absolute paths");
  const relative = path.relative(source, build);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(
      "build must be a new directory inside the Chromium checkout",
    );
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 256)
    throw new Error("jobs must be an integer between 1 and 256");
  const reviewed = Object.hasOwn(targets, target) ? targets[target] : null;
  if (!reviewed)
    throw new Error(`target must be one of ${Object.keys(targets).join(", ")}`);
  const assignment = (name) => {
    const matches = [
      ...gnArgs.matchAll(
        new RegExp(`^\\s*${name}\\s*=\\s*([^#\\n]+)\\s*(?:#.*)?$`, "gm"),
      ),
    ];
    if (matches.length !== 1)
      throw new Error(`GN argument must be explicit once: ${name}`);
    return matches[0][1].trim();
  };
  if (
    assignment("target_os") !== '"android"' ||
    !['"arm64"', '"x64"'].includes(assignment("target_cpu")) ||
    !reviewed.reviewed(assignment)
  )
    throw new Error(reviewed.refusal);
  return {
    target,
    apks: reviewed.apks.map((apk) => path.join(build, apk)),
    commands: [
      ["gn", ["gen", relative]],
      ["autoninja", ["-C", relative, "-j", String(jobs), target]],
    ],
  };
}

export async function buildChromiumBrowser(options) {
  if (process.platform !== "linux")
    throw new Error("Android Chromium compilation requires a Linux build host");
  const { source, build, argsFile, jobs, target, ...preparation } = options;
  const gnArgs = fs.readFileSync(argsFile, "utf8");
  const plan = chromiumBuildPlan({ source, build, gnArgs, jobs, target });
  if (fs.existsSync(build))
    throw new Error("Chromium build directory must be new");
  let component = null;
  if (plan.target === "chrome_public_apk") {
    component = await prepareChromiumBrowser({ source, ...preparation });
  } else {
    // A WebView provider carries no browser component, so it takes no component inputs.
    const { out, ...unused } = preparation;
    if (Object.keys(unused).length)
      throw new Error(
        `${plan.target} takes no component inputs: ${Object.keys(unused).join(", ")}`,
      );
    if (!out || !path.isAbsolute(out) || fs.existsSync(out))
      throw new Error("out must be a new absolute directory");
    fs.mkdirSync(out, { recursive: true });
  }
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "args.gn"), gnArgs, { flag: "wx" });
  for (const [command, args] of plan.commands)
    execFileSync(command, args, { cwd: source, stdio: "inherit" });
  const produced = plan.apks.filter((file) => fs.existsSync(file));
  if (produced.length !== 1)
    throw new Error(
      `Chromium compilation must produce exactly one ${plan.target} APK`,
    );
  const apk = produced[0];
  const bytes = fs.readFileSync(apk);
  if (!bytes.length)
    throw new Error("Chromium compilation produced an empty APK");
  const report = {
    schemaVersion: 1,
    component,
    target: plan.target,
    gnArgsSha256: createHash("sha256").update(gnArgs).digest("hex"),
    apk: {
      path: apk,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    browserBuilt: true,
    releaseQualified: false,
    installedNativeMessagingVerified: false,
  };
  fs.writeFileSync(
    path.join(preparation.out, "chromium-build.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { flag: "wx" },
  );
  return report;
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  const names = new Set([
    "source",
    "extension",
    "out",
    "certificate",
    "application",
    "revision",
    "build",
    "args-file",
    "jobs",
    "embed-host",
    "target",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, "");
    const key =
      { "args-file": "argsFile", "embed-host": "embedHost" }[name] ?? name;
    if (
      !args[index].startsWith("--") ||
      !names.has(name) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--") ||
      Object.hasOwn(options, key)
    )
      throw new Error(`Invalid build argument: ${args[index]}`);
    options[key] =
      name === "jobs"
        ? Number(args[index + 1])
        : name === "embed-host"
          ? args[index + 1] === "true"
          : args[index + 1];
    if (name === "embed-host" && !["true", "false"].includes(args[index + 1]))
      throw new Error("embed-host must be true or false");
  }
  console.log(JSON.stringify(await buildChromiumBrowser(options), null, 2));
}
if (import.meta.main) await main();
