/**
 * Exercises repository artifact authority against real temporary trees and the
 * checked-out monorepo; no archive, network, or native binary is substituted.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../artifact-authority-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CONTRACT_SCRIPT = fileURLToPath(
  new URL("../artifact-authority-contract.mjs", import.meta.url),
);
const SHELL_PARAMETER_PREFIX = "$";

const CONTRACT_FILES: Record<string, string> = {
  "plugins/plugin-local-inference/native/verify/Makefile":
    "cuda_verify: cuda_verify.cu\n\tnvcc cuda_verify.cu -o cuda_verify\n",
  "plugins/plugin-local-inference/native/.gitignore": "verify/cuda_verify\n",
  "packages/app-core/scripts/aosp/compile-libllama.mjs":
    "// plugins/plugin-local-inference/native/llama.cpp -> libelizainference.so\n",
  ".github/workflows/build-llama-ffi-android.yml":
    "jobs:\n  build:\n    steps:\n      - run: node packages/app-core/scripts/aosp/compile-libllama.mjs\n      - uses: actions/upload-artifact@v4\n        with:\n          if-no-files-found: error\n",
  "packages/os/linux/elizaos/scripts/stage-agent-artifacts.sh": `AGENT_BUNDLE="${SHELL_PARAMETER_PREFIX}{ROOT}/packages/agent/dist-mobile/agent-bundle.js"\nOUT="${SHELL_PARAMETER_PREFIX}{LINUX_DIR}/artifacts/${SHELL_PARAMETER_PREFIX}{ARCH}"\necho "missing built agent bundle"\n`,
};

function write(root: string, relativePath: string, content: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function buildRepo({
  scripts = {
    postinstall: "bun packages/scripts/ensure-workspace-symlinks.mjs",
    "install:light": "bun install",
  },
  gitignore = "node_modules/\n",
  workflow = "name: CI\n# elizaOS/eliza-archive is not an artifact source\njobs: {}\n",
}: {
  scripts?: Record<string, string>;
  gitignore?: string;
  workflow?: string;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "artifact-authority-contract-"));
  write(root, "package.json", JSON.stringify({ scripts }));
  write(root, ".gitignore", gitignore);
  write(root, ".github/workflows/ci.yml", workflow);
  for (const [path, content] of Object.entries(CONTRACT_FILES)) {
    write(root, path, content);
  }
  return root;
}

function withRepo(
  options: Parameters<typeof buildRepo>[0],
  assertion: (root: string) => void,
): void {
  const root = buildRepo(options);
  try {
    assertion(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("artifact-authority-contract", () => {
  test("accepts source-owned producers without a global archive hook", () => {
    withRepo({}, (root) => {
      expect(runContract(root)).toEqual({
        ok: true,
        contracts: Object.keys(CONTRACT_FILES),
        automationFilesScanned: 2,
        packageManifestsScanned: 1,
      });
    });
  });

  test("rejects a postinstall archive overlay", () => {
    withRepo(
      {
        scripts: {
          postinstall: "bun packages/scripts/sync-artifacts.mjs",
        },
      },
      (root) => {
        expect(() => runContract(root)).toThrow(/postinstall revives retired/);
      },
    );
  });

  test("rejects a hidden opt-in root sync command", () => {
    withRepo(
      {
        scripts: {
          "sync:artifacts": "bun packages/scripts/sync-artifacts.mjs",
        },
      },
      (root) => {
        expect(() => runContract(root)).toThrow(
          /sync:artifacts revives retired/,
        );
      },
    );
  });

  test("rejects a retired aggregate manifest even without a hook", () => {
    withRepo({}, (root) => {
      write(root, "packages/scripts/artifacts-manifest.json", "{}\n");
      expect(() => runContract(root)).toThrow(/manifest\.json is retired/);
    });
  });

  test("rejects ignore rules that conceal archive state or prebuilt CUDA output", () => {
    withRepo(
      {
        gitignore:
          ".eliza-artifacts-version\nplugins/plugin-local-inference/native/verify/cuda_verify\n",
      },
      (root) => {
        expect(() => runContract(root)).toThrow(
          /.gitignore still hides retired archive state/,
        );
      },
    );
  });

  test("rejects the obsolete OS overlay instead of the producer-owned stage", () => {
    withRepo(
      {
        gitignore:
          "packages/os/linux/elizaos/config/includes.chroot/opt/elizaos-artifacts/elizaos-app/musl-runtime/bun\n",
      },
      (root) => {
        expect(() => runContract(root)).toThrow(
          /.gitignore still hides retired archive state.*musl-runtime\/bun/,
        );
      },
    );
  });

  test("allows archive history in comments but rejects active workflow use", () => {
    withRepo(
      {
        workflow:
          "name: CI\n# no eliza-dev-artifacts.tar.gz dependency\njobs:\n  sync:\n    steps:\n      - run: bun packages/scripts/sync-artifacts.mjs\n",
      },
      (root) => {
        expect(() => runContract(root)).toThrow(/ci\.yml revives retired/);
      },
    );
  });

  test("rejects the retired repository in an active composite action", () => {
    withRepo({}, (root) => {
      write(
        root,
        ".github/actions/bootstrap/action.yml",
        "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: curl -fsS https://github.com/elizaOS/eliza-archive/releases/latest\n",
      );
      expect(() => runContract(root)).toThrow(
        /\.github\/actions\/bootstrap\/action\.yml revives retired.*elizaOS\/eliza-archive/,
      );
    });
  });

  test("rejects a workspace lifecycle script that revives the archive", () => {
    withRepo({}, (root) => {
      write(
        root,
        "plugins/example/package.json",
        JSON.stringify({
          scripts: {
            postinstall:
              "curl -fsS https://github.com/elizaOS/eliza-archive/releases/latest",
          },
        }),
      );
      expect(() => runContract(root)).toThrow(
        /plugins\/example\/package\.json script postinstall revives retired/,
      );
    });
  });

  test("rejects removal of an explicit source-owned producer", () => {
    withRepo({}, (root) => {
      write(
        root,
        "plugins/plugin-local-inference/native/verify/Makefile",
        "all:\n\ttrue\n",
      );
      expect(() => runContract(root)).toThrow(/lost source-owned artifact/);
    });
  });

  test("the real repository satisfies the contract", () => {
    const result = runContract(REAL_REPO_ROOT);
    expect(result.ok).toBe(true);
    expect(result.contracts).toEqual(Object.keys(CONTRACT_FILES));
    expect(result.automationFilesScanned).toBeGreaterThan(0);
    expect(result.packageManifestsScanned).toBeGreaterThan(1);
  });

  test("the CLI boundary exits non-zero with the actionable violation", () => {
    withRepo(
      {
        scripts: {
          postinstall: "bun packages/scripts/sync-artifacts.mjs",
        },
      },
      (root) => {
        const script = join(
          root,
          "packages/scripts/artifact-authority-contract.mjs",
        );
        mkdirSync(dirname(script), { recursive: true });
        copyFileSync(CONTRACT_SCRIPT, script);
        const result = spawnSync("node", [script], {
          cwd: root,
          encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "package.json script postinstall revives retired global artifact authority",
        );
      },
    );
  });
});
