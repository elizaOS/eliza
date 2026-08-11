/**
 * Proves the packaging-time codesign shim rewrites only the Bun permission
 * host, using both captured argv and a real ad-hoc-signed macOS executable.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const wrapperPath = path.join(packageRoot, "scripts", "bin", "codesign");
const temporaryRoots: string[] = [];

function createFixtureApp(): {
  root: string;
  bunPath: string;
  helperPath: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "eliza-codesign-wrapper-"));
  temporaryRoots.push(root);
  const appBundle = path.join(root, "Fixture App.app");
  const macosDir = path.join(appBundle, "Contents", "MacOS");
  mkdirSync(macosDir, { recursive: true });
  writeFileSync(
    path.join(appBundle, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.elizaos.fixture</string></dict></plist>',
  );
  return {
    root,
    bunPath: path.join(macosDir, "bun"),
    helperPath: path.join(macosDir, "process_helper"),
  };
}

function run(command: string, args: string[], env = process.env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status ?? 1}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function signedIdentifier(target: string): string {
  const result = run("/usr/bin/codesign", ["-d", "--verbose=4", target]);
  const identifier = result.stderr.match(/^Identifier=(.+)$/m)?.[1];
  if (!identifier) {
    throw new Error(`codesign did not report an identifier for ${target}`);
  }
  return identifier;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Electrobun codesign wrapper", () => {
  it("is executable and valid Bash", () => {
    expect(statSync(wrapperPath).mode & 0o111).not.toBe(0);
    run("/bin/bash", ["-n", wrapperPath]);
  });

  it("is first on PATH for the production build, packaged smoke, and direct dev entrypoints", () => {
    const desktopBuild = readFileSync(
      path.resolve(packageRoot, "../../scripts/desktop-build.mjs"),
      "utf8",
    );
    const smokeScript = readFileSync(
      path.join(packageRoot, "scripts", "smoke-test.sh"),
      "utf8",
    );
    const packageManifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(desktopBuild).toMatch(
      /PATH: `\$\{path\.join\(ELECTROBUN_DIR, "scripts", "bin"\)/,
    );
    expect(smokeScript).toContain("bun run build -- --env=");
    expect(packageManifest.scripts.dev).toContain(
      'PATH="$PWD/scripts/bin:$PATH"',
    );
  });

  it("replaces Electrobun's basename identifier only for Contents/MacOS/bun", () => {
    const { root, bunPath, helperPath } = createFixtureApp();
    const fakeCodesign = path.join(root, "codesign-delegate");
    const fakePlutil = path.join(root, "plutil-delegate");
    const capturePath = path.join(root, "args.bin");
    writeFileSync(
      fakeCodesign,
      '#!/usr/bin/env bash\nprintf \'%s\\0\' "$@" > "$ELIZA_CODESIGN_CAPTURE"\n',
    );
    chmodSync(fakeCodesign, 0o755);
    writeFileSync(
      fakePlutil,
      "#!/usr/bin/env bash\nprintf '%s\\n' ai.elizaos.fixture\n",
    );
    chmodSync(fakePlutil, 0o755);
    writeFileSync(bunPath, "bun");
    writeFileSync(helperPath, "helper");
    const env = {
      ...process.env,
      ELIZA_APP_ID: "ai.wrong.global",
      ELIZA_CODESIGN_CAPTURE: capturePath,
      ELIZA_REAL_CODESIGN: fakeCodesign,
      ELIZA_REAL_PLUTIL: fakePlutil,
    };

    run(
      wrapperPath,
      ["--force", "--sign", "fixture", "--identifier", "bun", bunPath],
      env,
    );
    expect(
      readFileSync(capturePath).toString("utf8").split("\0").filter(Boolean),
    ).toEqual([
      "--force",
      "--sign",
      "fixture",
      "--identifier",
      "ai.elizaos.fixture",
      bunPath,
    ]);

    run(
      wrapperPath,
      [
        "--force",
        "--sign",
        "fixture",
        "--identifier",
        "process_helper",
        helperPath,
      ],
      env,
    );
    expect(
      readFileSync(capturePath).toString("utf8").split("\0").filter(Boolean),
    ).toEqual([
      "--force",
      "--sign",
      "fixture",
      "--identifier",
      "process_helper",
      helperPath,
    ]);

    run(wrapperPath, ["-d", "--verbose=4", bunPath], env);
    expect(
      readFileSync(capturePath).toString("utf8").split("\0").filter(Boolean),
    ).toEqual(["-d", "--verbose=4", bunPath]);
  });

  it.runIf(process.platform === "darwin")(
    "writes the app id into a real temporary Bun Mach-O while preserving a helper id",
    () => {
      const { bunPath, helperPath } = createFixtureApp();
      copyFileSync("/usr/bin/true", bunPath);
      copyFileSync("/usr/bin/true", helperPath);
      const env = {
        ...process.env,
        ELIZA_APP_ID: "ai.wrong.global",
        ELIZA_REAL_CODESIGN: "/usr/bin/codesign",
        ELIZA_REAL_PLUTIL: "/usr/bin/plutil",
      };

      run(
        wrapperPath,
        ["--force", "--sign", "-", "--identifier", "bun", bunPath],
        env,
      );
      run(
        wrapperPath,
        [
          "--force",
          "--sign",
          "-",
          "--identifier",
          "process_helper",
          helperPath,
        ],
        env,
      );

      expect(signedIdentifier(bunPath)).toBe("ai.elizaos.fixture");
      expect(signedIdentifier(helperPath)).toBe("process_helper");
    },
  );
});
