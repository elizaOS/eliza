#!/usr/bin/env node
/** Owned Android Chromium compilation. Signing, AOSP admission and boot qualification remain separate. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareChromiumBrowser } from "./prepare-chromium-browser.ts";

export function chromiumBuildPlan({ source, build, gnArgs, jobs = 8 }) {
  if (!path.isAbsolute(source) || !path.isAbsolute(build))
    throw new Error("source and build must be absolute paths");
  const relative = path.relative(source, build);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(
      "build must be a new directory inside the Chromium checkout",
    );
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 256)
    throw new Error("jobs must be an integer between 1 and 256");
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
    assignment("is_desktop_android") !== "true" ||
    assignment("chrome_public_manifest_package") !== '"ai.elizaos.chromium"'
  )
    throw new Error(
      "GN arguments must select the reviewed owned Desktop Android browser",
    );
  return {
    target: "chrome_public_apk",
    commands: [
      ["gn", ["gen", relative]],
      ["autoninja", ["-C", relative, "-j", String(jobs), "chrome_public_apk"]],
    ],
  };
}

export async function buildChromiumBrowser(options) {
  if (process.platform !== "linux")
    throw new Error("Android Chromium compilation requires a Linux build host");
  const { source, build, argsFile, jobs, ...preparation } = options;
  const gnArgs = fs.readFileSync(argsFile, "utf8");
  const plan = chromiumBuildPlan({ source, build, gnArgs, jobs });
  if (fs.existsSync(build))
    throw new Error("Chromium build directory must be new");
  const component = await prepareChromiumBrowser({ source, ...preparation });
  fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "args.gn"), gnArgs, { flag: "wx" });
  for (const [command, args] of plan.commands)
    execFileSync(command, args, { cwd: source, stdio: "inherit" });
  const apk = path.join(build, "apks/ChromePublic.apk");
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
