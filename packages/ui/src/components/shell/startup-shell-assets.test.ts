import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../",
);

const shellSourcePaths = [
  "packages/ui/src/components/shell/StartupShell.tsx",
  "packages/ui/src/components/shell/FirstRunShell.tsx",
];

describe("startup shell assets", () => {
  it("keeps shared shell renderers free of startup behavior imports", () => {
    const behaviorTokens = [
      "../api",
      "../../api",
      "useApp",
      "useFirstRunController",
      "useStartupShellController",
      "Capacitor",
      "invokeDesktopBridgeRequest",
      "savePersisted",
      "localStorage",
      "sessionStorage",
      "document.addEventListener",
      "window.location",
      "createVoiceCapture",
      "speechSynthesis",
      "SpeechRecognition",
      "ensureStoreBuildWorkspaceFolder",
      "applyLaunchConnection",
    ];

    for (const sourcePath of shellSourcePaths) {
      const source = readFileSync(resolve(repoRoot, sourcePath), "utf8");
      for (const token of behaviorTokens) {
        expect(source).not.toContain(token);
      }
    }
  });

  it("does not reference missing legacy startup background images", () => {
    const legacySvg = `${"spla"}sh-bg.svg`;
    const legacyPng = `${"spla"}sh-bg.png`;
    for (const sourcePath of shellSourcePaths) {
      const source = readFileSync(resolve(repoRoot, sourcePath), "utf8");
      expect(source).not.toContain(legacySvg);
      expect(source).not.toContain(legacyPng);
    }
  });

  it("keeps the bootstrap shell on the elizaOS white and blue startup surface", () => {
    const source = readFileSync(
      resolve(repoRoot, "packages/ui/src/components/shell/StartupShell.tsx"),
      "utf8",
    );

    const bootstrapShell = source.slice(
      source.indexOf("function BootstrapGateShell"),
    );
    expect(bootstrapShell).toContain("bg-[#F7F9FF]");
    expect(bootstrapShell).toContain("text-[#0B35F1]");
    expect(bootstrapShell).not.toContain("bg-[#ffe600]");
    expect(bootstrapShell).not.toContain("radial-gradient");
    expect(bootstrapShell).not.toContain("blur-[");
  });

  it("keeps the loading shell on the elizaOS white and blue startup surface", () => {
    const source = readFileSync(
      resolve(repoRoot, "packages/ui/src/components/shell/StartupShell.tsx"),
      "utf8",
    );

    const loadingShell = source.slice(
      source.indexOf("function StartupLoading"),
      source.indexOf("function BootstrapGateShell"),
    );
    expect(loadingShell).toContain("bg-[#F7F9FF]");
    expect(loadingShell).toContain("text-[#0B35F1]");
    expect(loadingShell).not.toContain("bg-black");
    expect(loadingShell).not.toContain("radial-gradient");
    expect(loadingShell).not.toContain("blur-[");
  });

  it("keeps the startup failure shell on the elizaOS white and blue surface", () => {
    const source = readFileSync(
      resolve(
        repoRoot,
        "packages/ui/src/components/shell/StartupFailureView.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("bg-[#F7F9FF]");
    expect(source).toContain("text-[#0B35F1]");
    expect(source).not.toContain("bg-danger");
    expect(source).not.toContain("text-danger");
    expect(source).not.toContain('variant="danger"');
    expect(source).not.toContain("radial-gradient");
  });

  it("keeps the first-run shell on the tokenized onboarding surface", () => {
    const source = readFileSync(
      resolve(repoRoot, "packages/ui/src/components/shell/FirstRunShell.tsx"),
      "utf8",
    );

    expect(source).toContain("bg-bg");
    expect(source).toContain("text-txt");
    expect(source).toContain("bg-accent");
    expect(source).not.toContain("bg-black");
    expect(source).not.toContain("radial-gradient");
    expect(source).not.toContain("blur-[");
  });
});
