import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";

const EXPECTED_FILES = ["game.js", "index.html", "styles.css"];
const REAL_HOME_DIR = os.userInfo().homedir;
const CODEX_AUTH_PATH = path.join(REAL_HOME_DIR, ".codex", "auth.json");

function isCodexCliAvailable(): boolean {
  const probe = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5_000,
  });
  return probe.status === 0;
}

const CODEX_AVAILABLE = isCodexCliAvailable();
const CODEX_AUTH_AVAILABLE = fs.existsSync(CODEX_AUTH_PATH);
function createIsolatedCodexHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-codex-home-"));
  const codexDir = path.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.copyFileSync(CODEX_AUTH_PATH, path.join(codexDir, "auth.json"));
  fs.writeFileSync(
    path.join(codexDir, "config.toml"),
    'model = "gpt-5.4"\n',
    "utf8",
  );
  return homeDir;
}

function runCodexExec(
  workingDirectory: string,
  homeDir: string,
  prompt: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "--model",
        "gpt-5.4",
        "--full-auto",
        "--skip-git-repo-check",
        "--color",
        "never",
        prompt,
      ],
      {
        cwd: workingDirectory,
        env: {
          ...process.env,
          HOME: homeDir,
          NO_COLOR: "1",
          TERM: "dumb",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          [
            `codex exec timed out after ${timeoutMs}ms`,
            stdout && `stdout:\n${stdout}`,
            stderr && `stderr:\n${stderr}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

describeIf(CODEX_AVAILABLE && CODEX_AUTH_AVAILABLE)(
  "Coding agent Codex artifact generation",
  () => {
    const cleanupDirs: string[] = [];

    afterEach(() => {
      for (const dir of cleanupDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("creates a browser Tetris game in the expected files", async () => {
      const homeDir = createIsolatedCodexHome();
      const workingDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "eliza-codex-tetris-"),
      );
      cleanupDirs.push(homeDir, workingDirectory);

      const prompt = [
        "Create a browser Tetris game in the current directory.",
        "Write exactly three files at the workspace root: index.html, styles.css, and game.js.",
        "Do not create any other files or folders.",
        "index.html must include elements with ids board, score, and next-piece, and load styles.css and game.js via relative paths.",
        "game.js must implement keyboard controls for ArrowLeft, ArrowRight, ArrowDown, ArrowUp, and Space.",
        "Render the score into #score and the next-piece preview into #next-piece.",
        "Use plain browser JavaScript only.",
      ].join(" ");

      const result = await runCodexExec(
        workingDirectory,
        homeDir,
        prompt,
        300_000,
      );
      const resultOutput = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n\n");

      expect(result.exitCode, resultOutput).toBe(0);

      const entries = fs
        .readdirSync(workingDirectory)
        .filter((entry) => !entry.startsWith("."))
        .sort();
      expect(entries).toEqual(EXPECTED_FILES);

      const indexHtml = fs.readFileSync(
        path.join(workingDirectory, "index.html"),
        "utf8",
      );
      const stylesCss = fs.readFileSync(
        path.join(workingDirectory, "styles.css"),
        "utf8",
      );
      const gameJs = fs.readFileSync(
        path.join(workingDirectory, "game.js"),
        "utf8",
      );

      expect(indexHtml).toMatch(/id=["']board["']/i);
      expect(indexHtml).toMatch(/id=["']score["']/i);
      expect(indexHtml).toMatch(/id=["']next-piece["']/i);
      expect(indexHtml).toMatch(/href=["']\.?\/?styles\.css["']/i);
      expect(indexHtml).toMatch(/src=["']\.?\/?game\.js["']/i);

      expect(stylesCss).toMatch(/[#.]board\b/i);
      // Codex sometimes styles the preview container class instead of the exact id.
      expect(stylesCss).toMatch(/(?:[#.]next-piece\b|[.]preview\b)/i);

      expect(gameJs).toMatch(/ArrowLeft/);
      expect(gameJs).toMatch(/ArrowRight/);
      expect(gameJs).toMatch(/ArrowDown/);
      expect(gameJs).toMatch(/ArrowUp/);
      expect(gameJs).toMatch(/Space|["'] ["']/);
      expect(gameJs).toMatch(/getElementById\(["']score["']\)/);
      expect(gameJs).toMatch(/getElementById\(["']next-piece["']\)/);

      const syntaxCheck = spawnSync(
        process.execPath,
        ["--check", path.join(workingDirectory, "game.js")],
        { encoding: "utf8" },
      );
      expect(
        syntaxCheck.status,
        [syntaxCheck.stdout, syntaxCheck.stderr].filter(Boolean).join("\n\n"),
      ).toBe(0);
    }, 360_000);
  },
);
