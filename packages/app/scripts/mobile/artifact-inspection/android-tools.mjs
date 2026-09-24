/** Invokes Android artifact inspection tools and decodes their manifest evidence. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function resolveAndroidBuildTool(
  sdkRoot,
  toolName,
  { platform = process.platform } = {},
) {
  const buildToolsRoot = path.join(sdkRoot, "build-tools");
  if (!fs.existsSync(buildToolsRoot)) return null;
  const versions = fs
    .readdirSync(buildToolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse();
  const executableNames =
    platform === "win32" ? [`${toolName}.exe`, toolName] : [toolName];
  for (const version of versions) {
    for (const executableName of executableNames) {
      const candidate = path.join(buildToolsRoot, version, executableName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function dumpAndroidArtifactBadging(
  aapt,
  artifact,
  { spawnSyncImpl = spawnSync } = {},
) {
  const badging = spawnSyncImpl(aapt, ["dump", "badging", artifact], {
    encoding: "utf8",
  });
  if (badging.status !== 0) {
    throw new Error(
      `[mobile-build] Could not inspect ${artifact} badging: ${
        badging.stderr || badging.stdout || `aapt exited with ${badging.status}`
      }`,
    );
  }
  return badging.stdout;
}

export function dumpAndroidArtifactManifest(
  aapt,
  artifact,
  { spawnSyncImpl = spawnSync } = {},
) {
  const manifest = spawnSyncImpl(
    aapt,
    ["dump", "xmltree", artifact, "AndroidManifest.xml"],
    { encoding: "utf8" },
  );
  if (manifest.status !== 0) {
    throw new Error(
      `[mobile-build] Could not inspect ${artifact} AndroidManifest.xml: ${
        manifest.stderr ||
        manifest.stdout ||
        `aapt exited with ${manifest.status}`
      }`,
    );
  }
  return manifest.stdout;
}

export function parseAaptAttributeValue(encodedValue) {
  const rawValue = encodedValue.match(/\(Raw: "([^"]*)"\)\s*$/)?.[1];
  if (rawValue !== undefined) return rawValue;
  const quotedValue = encodedValue.match(/^"([^"]*)"/)?.[1];
  if (quotedValue !== undefined) return quotedValue;
  const typedValue = encodedValue.match(
    /^\(type (0x[0-9a-f]+)\)(0x[0-9a-f]+)$/i,
  );
  if (!typedValue) return encodedValue.trim();
  if (typedValue[1].toLowerCase() === "0x12") {
    return typedValue[2].toLowerCase() === "0x0" ? "false" : "true";
  }
  return String(Number.parseInt(typedValue[2], 16));
}

/** Converts AAPT's indented xmltree output into the policy evidence shape. */
export function androidPlayManifestEvidenceFromAapt(manifestText) {
  const tags = [];
  const stack = [];
  for (const line of String(manifestText).split(/\r?\n/)) {
    const element = line.match(/^(\s*)E: ([^\s(]+)(?:\s|$)/);
    if (element) {
      const indent = element[1].length;
      while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
      const tag = {
        ancestors: stack.map((ancestor) => ancestor.name),
        attributes: new Map(),
        indent,
        name: element[2],
      };
      tags.push(tag);
      stack.push(tag);
      continue;
    }
    const attribute = line.match(
      /^(\s*)A: ([^=(]+?)(?:\(0x[0-9a-f]+\))?=(.*)$/i,
    );
    if (!attribute || stack.length === 0) continue;
    const qualifiedName = attribute[2].trim();
    stack
      .at(-1)
      .attributes.set(
        qualifiedName.split(":").at(-1),
        parseAaptAttributeValue(attribute[3]),
      );
  }

  const values = (names, attributeName = "name") =>
    [
      ...new Set(
        tags
          .filter((tag) => names.includes(tag.name))
          .map((tag) => tag.attributes.get(attributeName))
          .filter(Boolean),
      ),
    ].sort();
  const componentNames = new Set([
    "activity",
    "activity-alias",
    "provider",
    "receiver",
    "service",
  ]);
  const application = tags.find((tag) => tag.name === "application");
  const usesSdk = tags.find((tag) => tag.name === "uses-sdk");
  const isInsideQueries = (tag) => tag.ancestors.includes("queries");
  return {
    actions: values(["action"]),
    application: {
      allowBackup: application?.attributes.get("allowBackup") ?? null,
      debuggable: application?.attributes.get("debuggable") ?? "false",
      usesCleartextTraffic:
        application?.attributes.get("usesCleartextTraffic") ?? null,
    },
    components: [
      ...new Set(
        tags
          .filter((tag) => componentNames.has(tag.name))
          .map((tag) => {
            const componentName = tag.attributes.get("name");
            return componentName ? `${tag.name}:${componentName}` : null;
          })
          .filter(Boolean),
      ),
    ].sort(),
    metadataNames: values(["meta-data"]),
    permissions: values(["uses-permission", "uses-permission-sdk-23"]),
    queryActions: [
      ...new Set(
        tags
          .filter((tag) => tag.name === "action" && isInsideQueries(tag))
          .map((tag) => tag.attributes.get("name"))
          .filter(Boolean),
      ),
    ].sort(),
    queryPackages: [
      ...new Set(
        tags
          .filter((tag) => tag.name === "package" && isInsideQueries(tag))
          .map((tag) => tag.attributes.get("name"))
          .filter(Boolean),
      ),
    ].sort(),
    targetSdkVersion: usesSdk?.attributes.get("targetSdkVersion") ?? null,
  };
}
