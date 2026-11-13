/** Checks the actual public import and emitted test-auth branches. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const entries = [
  "cloud-ui/components/auth/authorize-content.tsx",
  "cloud/join/lib/use-join-session.ts",
  "cloud/lib/use-session-auth.ts",
  "cloud/public-pages/pages/login/steward-login-section.tsx",
  "cloud/shell/StewardProvider.tsx",
].map((entry) => path.join(root, "packages/ui/src", entry));
const markers = [
  "eliza-test-auth",
  "local-live-test-user@agent.local",
  "22222222-2222-4222-8222-222222222222",
  "/api/test/auth/session",
  "Continue with local test account",
  "Playwright test auth requires a pre-seeded Steward token.",
];

describe("test-auth build boundary", () => {
  it("keeps the public UI entry importable without a Vite environment", () => {
    const entry = pathToFileURL(path.join(root, "packages/ui/src/index.ts"));
    const result = execFileSync(
      process.execPath,
      [
        "--conditions=eliza-source",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const ui = await import(${JSON.stringify(entry.href)}); console.log(JSON.stringify({sessionHook: typeof ui.useSessionAuth}));`,
      ],
      { cwd: root, encoding: "utf8", timeout: 120_000 },
    );
    expect(JSON.parse(result)).toEqual({ sessionHook: "function" });
  });

  it.each([false, true])(
    "compiles test-auth branches for the explicit build flag %s",
    async (enabled) => {
      // External imports keep this check scoped to the five real modules.
      // The application build and browser flow remain separate checks.
      const result = await build({
        root,
        configFile: false,
        logLevel: "error",
        define: {
          "import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH": JSON.stringify(
            String(enabled),
          ),
          "import.meta.env.VITE_LOCAL_DEDICATED_TEST_API_KEY": JSON.stringify(
            "fixture-only-local-test-key",
          ),
        },
        build: {
          write: false,
          minify: true,
          lib: { entry: entries, formats: ["es"] },
          rolldownOptions: { external: () => true },
        },
      });
      if (!Array.isArray(result) && !("output" in result)) {
        throw new Error("Test-auth boundary check requires a completed build");
      }
      const code = (Array.isArray(result) ? result : [result])
        .flatMap((output) => output.output)
        .filter((output) => output.type === "chunk")
        .map((output) => output.code)
        .join("\n");
      const output = testOutputPath("ui-test-auth-boundary");
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, `auth-${enabled}.js`), code);
      for (const marker of markers) {
        expect(code.includes(marker), marker).toBe(enabled);
      }
    },
  );
});
