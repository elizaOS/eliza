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
});
