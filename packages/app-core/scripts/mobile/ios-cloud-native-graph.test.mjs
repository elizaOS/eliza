/**
 * Exercises pure-cloud native-graph rejection against deterministic generated
 * iOS trees, including a tree Capacitor already considers ready.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isCapacitorPlatformReady } from "../lib/capacitor-platform-templates.mjs";
import {
  assertIosCloudNativeGraph,
  IOS_LOCAL_EXECUTION_PLUGIN_CLASSES,
  inspectIosCloudNativeGraph,
  reconcileIosCapacitorPluginClasses,
} from "./ios-cloud-native-graph.mjs";

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("ios-cloud native graph", () => {
  it("rejects local execution state in an otherwise ready incremental iOS tree", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ios-cloud-native-graph-"),
    );
    const appDir = path.join(fixtureRoot, "app");
    const iosRoot = path.join(appDir, "ios", "App");
    const configPath = write(
      iosRoot,
      path.join("App", "capacitor.config.json"),
      `${JSON.stringify({
        packageClassList: [...IOS_LOCAL_EXECUTION_PLUGIN_CLASSES],
        plugins: {
          Agent: { runtimeMode: "local", fullBunAvailable: "1" },
        },
      })}\n`,
    );
    write(
      iosRoot,
      "Podfile",
      "pod 'ElizaosCapacitorBunRuntime'\npod 'ElizaBunEngine'\n",
    );
    write(
      iosRoot,
      path.join("App.xcodeproj", "project.pbxproj"),
      "ElizaBunEngine in Frameworks\n",
    );
    write(iosRoot, "Podfile.lock", "- ElizaosCapacitorMobileAgentBridge\n");
    write(iosRoot, path.join("Pods", "Manifest.lock"), "- LlamaCppCapacitor\n");
    write(
      iosRoot,
      path.join("Pods", "Pods.xcodeproj", "project.pbxproj"),
      "ElizaBunEngine in Frameworks\n",
    );
    write(
      iosRoot,
      path.join("App", "public", "agent", "agent-bundle.js"),
      "stale local agent",
    );

    try {
      expect(isCapacitorPlatformReady("ios", { appDirValue: appDir })).toBe(
        true,
      );
      const findings = inspectIosCloudNativeGraph(iosRoot);
      expect(findings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("ElizaosCapacitorBunRuntime"),
          expect.stringContaining("ElizaBunEngine"),
          expect.stringContaining("ElizaosCapacitorMobileAgentBridge"),
          expect.stringContaining("LlamaCppCapacitor"),
          expect.stringContaining(
            "App.xcodeproj/project.pbxproj references ElizaBunEngine",
          ),
          expect.stringContaining("ElizaBunRuntimePlugin"),
          expect.stringContaining('runtimeMode is "local"'),
          expect.stringContaining("fullBunAvailable is enabled"),
          expect.stringContaining("local payload: agent"),
        ]),
      );
      expect(() => assertIosCloudNativeGraph(iosRoot)).toThrow(
        /ios-cloud native graph retains forbidden local execution state/,
      );

      expect(
        reconcileIosCapacitorPluginClasses(configPath, {
          forbidden: [...IOS_LOCAL_EXECUTION_PLUGIN_CLASSES],
        }),
      ).toBe(true);
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      config.plugins.Agent = {
        runtimeMode: "cloud",
        fullBunAvailable: "0",
      };
      fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
      for (const relativePath of [
        "Podfile",
        "Podfile.lock",
        path.join("App.xcodeproj", "project.pbxproj"),
        path.join("Pods", "Manifest.lock"),
        path.join("Pods", "Pods.xcodeproj", "project.pbxproj"),
      ]) {
        fs.writeFileSync(path.join(iosRoot, relativePath), "cloud graph\n");
      }
      fs.rmSync(path.join(iosRoot, "App", "public"), {
        recursive: true,
        force: true,
      });

      expect(inspectIosCloudNativeGraph(iosRoot)).toEqual([]);
      expect(() => assertIosCloudNativeGraph(iosRoot)).not.toThrow();
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("reconciles required and forbidden Capacitor classes idempotently", () => {
    const fixtureRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ios-plugin-classes-"),
    );
    const configPath = write(
      fixtureRoot,
      "capacitor.config.json",
      `${JSON.stringify({
        packageClassList: [
          "MobileAgentBridgePlugin",
          "UnrelatedPlugin",
          "ElizaBunRuntimePlugin",
        ],
      })}\n`,
    );
    try {
      const policy = {
        required: ["ElizaBunRuntimePlugin", "LlamaCppPlugin"],
        forbidden: ["MobileAgentBridgePlugin"],
      };
      expect(reconcileIosCapacitorPluginClasses(configPath, policy)).toBe(true);
      expect(
        JSON.parse(fs.readFileSync(configPath, "utf8")).packageClassList,
      ).toEqual(["UnrelatedPlugin", "ElizaBunRuntimePlugin", "LlamaCppPlugin"]);
      expect(reconcileIosCapacitorPluginClasses(configPath, policy)).toBe(
        false,
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
