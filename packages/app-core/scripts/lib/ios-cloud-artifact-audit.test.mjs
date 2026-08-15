/**
 * Deterministic final-artifact contracts for the iOS cloud-only audit. The
 * fixtures are synthetic `.app`/`.ipa` packages and injected native-tool
 * output; they prove rejection and attestation behavior, not Apple-device
 * execution or real code-signing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";

import {
  auditIosCloudArtifact,
  IOS_CLOUD_ARTIFACT_ATTESTATION_SCHEMA,
  resolveIosAppFromBuildSettingsJson,
} from "./ios-cloud-artifact-audit.mjs";
import { writeRendererBuildManifest } from "./renderer-build-manifest.mjs";

function makeFixture({ runtimeMode = "cloud" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-cloud-artifact-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<main>cloud</main>\n");
  fs.writeFileSync(path.join(dist, "assets", "app-deadbeef.js"), "cloud();\n");
  writeRendererBuildManifest(dist, {
    builtAt: "2026-08-12T00:00:00.000Z",
    commit: "0123456789abcdef",
    variant: "store",
    capacitorTarget: "ios",
    runtimeMode,
  });

  const app = path.join(root, "App.app");
  fs.cpSync(dist, path.join(app, "public"), { recursive: true });
  // Thin 64-bit Mach-O magic is sufficient because native-tool output is
  // injected below; no host architecture or Xcode installation is required.
  fs.writeFileSync(
    path.join(app, "App"),
    Buffer.from("cffaedfe00000000", "hex"),
  );
  return { app, dist, root };
}

function cleanNativeCommand(calls = []) {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === "codesign") return "valid on disk\n";
    if (args[0] === "otool") {
      return "App:\n\t/System/Library/Frameworks/WebKit.framework/WebKit\n";
    }
    if (args[0] === "nm") return "_main\n";
    if (args[0] === "strings") return "WKWebView\nEliza Cloud\n";
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

describe("iOS cloud final-artifact audit", () => {
  it("attests renderer identity, native inspection, signature verification, and claim boundary", () => {
    const fixture = makeFixture();
    const attestationPath = path.join(fixture.root, "attestation.json");
    const calls = [];
    try {
      const result = auditIosCloudArtifact({
        artifactPath: fixture.app,
        freshDistDir: fixture.dist,
        expectedRuntimeMode: "cloud",
        requireCodesign: true,
        attestationPath,
        command: cleanNativeCommand(calls),
        now: () => "2026-08-12T01:02:03.000Z",
      });
      expect(result.schema).toBe(IOS_CLOUD_ARTIFACT_ATTESTATION_SCHEMA);
      expect(result.verdict).toBe("pass");
      expect(result.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.renderer.runtimeMode).toBe("cloud");
      expect(result.signature).toEqual({ status: "verified", verified: true });
      expect(result.machOBinaries).toHaveLength(1);
      expect(result.claimBoundary).toContain("not_simulator_device");
      expect(calls.some(([command]) => command === "codesign")).toBe(true);
      expect(JSON.parse(fs.readFileSync(attestationPath, "utf8"))).toEqual(
        result,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects forbidden products and Mach-O load/symbol indicators and preserves failure evidence", () => {
    const fixture = makeFixture();
    const forbidden = path.join(
      fixture.app,
      "Frameworks",
      "ElizaBunEngine.framework",
      "ElizaBunEngine",
    );
    fs.mkdirSync(path.dirname(forbidden), { recursive: true });
    fs.writeFileSync(forbidden, Buffer.from("cffaedfe00000000", "hex"));
    const attestationPath = path.join(fixture.root, "failed.json");
    try {
      expect(() =>
        auditIosCloudArtifact({
          artifactPath: fixture.app,
          freshDistDir: fixture.dist,
          expectedRuntimeMode: "cloud",
          attestationPath,
          command: (_command, args) =>
            args[0] === "otool"
              ? "@rpath/ElizaBunEngine.framework/ElizaBunEngine\n"
              : args[0] === "nm"
                ? "_llama_model_load_from_file\n"
                : "agent-bundle.js\n",
        }),
      ).toThrow(/forbidden local-runtime product/);
      const failed = JSON.parse(fs.readFileSync(attestationPath, "utf8"));
      expect(failed.verdict).toBe("fail");
      expect(failed.findings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("ElizaBunEngine.framework"),
          expect.stringContaining("native indicator"),
        ]),
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("audits an IPA payload and marks an unsigned fixture as non-runtime evidence", () => {
    const fixture = makeFixture();
    const ipa = path.join(fixture.root, "Eliza.ipa");
    const zip = new AdmZip();
    zip.addLocalFolder(fixture.app, "Payload/App.app");
    zip.writeZip(ipa);
    try {
      const result = auditIosCloudArtifact({
        artifactPath: ipa,
        freshDistDir: fixture.dist,
        expectedRuntimeMode: "cloud",
        command: cleanNativeCommand(),
      });
      expect(result.artifactKind).toBe("ipa");
      expect(result.signature.status).toBe(
        "not-applicable-unsigned-simulator-or-development-build",
      );
      expect(result.signature.verified).toBe(false);
    } finally {
      fs.rmSync(`${ipa}.eliza-cloud-attestation.json`, { force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("selects the App product from Xcode build-settings JSON", () => {
    const json = JSON.stringify([
      {
        target: "Widget",
        buildSettings: {
          WRAPPER_EXTENSION: "appex",
          TARGET_BUILD_DIR: "/tmp/build",
          WRAPPER_NAME: "Widget.appex",
        },
      },
      {
        target: "App",
        buildSettings: {
          WRAPPER_EXTENSION: "app",
          TARGET_BUILD_DIR: "/tmp/build",
          WRAPPER_NAME: "Eliza.app",
        },
      },
    ]);
    expect(resolveIosAppFromBuildSettingsJson(json)).toBe(
      path.join("/tmp/build", "Eliza.app"),
    );
  });

  it("keeps the final artifact audit after xcodebuild and out of local-runtime lanes", () => {
    const runMobileBuild = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "run-mobile-build.mjs",
      ),
      "utf8",
    );
    const nativeBuild = runMobileBuild.indexOf('await run(\n    "xcodebuild",');
    const thinLaneGate = runMobileBuild.indexOf(
      "if (!includesLocalAgentPayload)",
      nativeBuild,
    );
    const finalAudit = runMobileBuild.indexOf(
      "auditIosCloudArtifact({",
      thinLaneGate,
    );
    expect(nativeBuild).toBeGreaterThan(-1);
    expect(thinLaneGate).toBeGreaterThan(nativeBuild);
    expect(finalAudit).toBeGreaterThan(thinLaneGate);
  });
});
