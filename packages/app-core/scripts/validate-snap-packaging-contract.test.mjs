/**
 * Exercises the structural Snap release gate against real workflow, shell,
 * and manifest text plus mutations for every reproduced false-green bypass.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  validateInstalledSnapSmokeSource,
  validatePackagingHarnessSource,
  validatePackagingWorkflowSource,
  validateSnapManifestSource,
  validateSnapPublishWorkflowSource,
  validateSnapWorkflowSource,
} from "./validate-snap-packaging-contract.mjs";

const FILE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(FILE_DIR, "../../..");

function readRepoFile(path) {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

const workflowSource = readRepoFile(".github/workflows/snap-build-test.yml");
const standalonePublishSource = readRepoFile(
  ".github/workflows/snap-publish.yml",
);
const aggregatePublishSource = readRepoFile(
  ".github/workflows/publish-packages.yml",
);
const packagingWorkflowSource = readRepoFile(
  ".github/workflows/test-packaging.yml",
);
const manifestSource = readRepoFile(
  "packages/app-core/packaging/snap/snapcraft.yaml",
);
const installedSmokeSource = readRepoFile(
  "packages/app-core/packaging/snap/test-installed-snap.sh",
);
const packagingHarnessSource = readRepoFile(
  "packages/app-core/packaging/test-packaging.sh",
);
const nodeArchiveLine =
  '      NODE_ARCHIVE="$CRAFT_PART_BUILD/node-v$' +
  "{NODE_VERSION}-linux-$" +
  '{NODE_ARCH}.tar.xz"';

function mutateYaml(source, mutator) {
  const document = parse(source);
  mutator(document);
  return stringify(document);
}

function jobStep(workflow, jobName, name) {
  return workflow.jobs[jobName].steps.find((step) => step.name === name);
}

function githubExpression(body) {
  return `\${{ ${body} }}`;
}

describe("Snap build workflow contract", () => {
  it("accepts the executable blocking workflow", () => {
    expect(() => validateSnapWorkflowSource(workflowSource)).not.toThrow();
  });

  it("rejects path filters that omit runtime-closure inputs", () => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      workflow.on.pull_request.paths = ["packages/agent/**"];
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow(
      /must not path-filter the runtime closure/,
    );
  });

  it("rejects a runner that is not bound to the architecture matrix", () => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      workflow.jobs["build-snap"]["runs-on"] = "ubuntu-24.04";
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow(
      /must bind runs-on to matrix.runner/,
    );
  });

  it.each([
    ["job dependency", (job) => (job.needs = "optional")],
    ["job condition", (job) => (job.if = githubExpression("false"))],
    [
      "non-blocking job",
      (job) => (job["continue-on-error"] = githubExpression("matrix.arm")),
    ],
  ])("rejects a disabling %s", (_label, mutateJob) => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      mutateJob(workflow.jobs["build-snap"]);
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow();
  });

  it("rejects a custom shell that masks the generated script status", () => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      jobStep(workflow, "build-snap", "Install and test snap").shell =
        "bash {0} || true";
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow(
      /must not override GitHub's fail-closed shell/,
    );
  });

  it("rejects disabled installed-runtime proof", () => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      jobStep(workflow, "build-snap", "Install and test snap").if =
        githubExpression("false");
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow(
      /must not be conditional/,
    );
  });

  it("rejects proof copied into comments and a dead step", () => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      const install = jobStep(workflow, "build-snap", "Install and test snap");
      const executableProof = install.run;
      install.run = executableProof
        .split("\n")
        .map((line) => `# ${line}`)
        .join("\n");
      workflow.jobs["build-snap"].steps.push({
        name: "Dead installed-runtime proof",
        if: githubExpression("false"),
        run: executableProof,
      });
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow();
  });

  it.each([
    [
      "wrong artifact path",
      (upload) => {
        upload.with.path = "*.snap";
      },
    ],
    [
      "missing-file success",
      (upload) => {
        delete upload.with["if-no-files-found"];
      },
    ],
  ])("rejects upload bypass: %s", (_label, mutateUpload) => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      mutateUpload(jobStep(workflow, "build-snap", "Upload snap artifact"));
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow();
  });

  it("rejects upload before installed proof", () => {
    const mutated = mutateYaml(workflowSource, (workflow) => {
      const steps = workflow.jobs["build-snap"].steps;
      const uploadIndex = steps.findIndex(
        (step) => step.name === "Upload snap artifact",
      );
      const [upload] = steps.splice(uploadIndex, 1);
      steps.splice(
        steps.findIndex((step) => step.name === "Install and test snap"),
        0,
        upload,
      );
    });
    expect(() => validateSnapWorkflowSource(mutated)).toThrow(
      /must preserve dataflow order/,
    );
  });

  it.each([
    [
      "mutable Snapcraft track",
      (workflow) => {
        jobStep(workflow, "build-snap", "Build snap").with[
          "snapcraft-channel"
        ] = "stable";
      },
    ],
    [
      "missing embedded build manifest",
      (workflow) => {
        jobStep(workflow, "build-snap", "Build snap").with["build-info"] =
          false;
      },
    ],
    [
      "SBOM of the checkout instead of the artifact",
      (workflow) => {
        jobStep(workflow, "build-snap", "Generate Snap SBOM").with.path = ".";
      },
    ],
    [
      "attestation of an unbound glob",
      (workflow) => {
        jobStep(workflow, "build-snap", "Attest Snap build provenance").with[
          "subject-path"
        ] = "*.snap";
      },
    ],
  ])("rejects provenance bypass: %s", (_label, mutateWorkflow) => {
    const mutated = mutateYaml(workflowSource, mutateWorkflow);
    expect(() => validateSnapWorkflowSource(mutated)).toThrow();
  });
});

describe("Snap publish paths", () => {
  it("accepts standalone and aggregate amd64 plus arm64 release jobs", () => {
    expect(() =>
      validateSnapPublishWorkflowSource(standalonePublishSource, {
        kind: "standalone",
      }),
    ).not.toThrow();
    expect(() =>
      validateSnapPublishWorkflowSource(aggregatePublishSource, {
        kind: "aggregate",
      }),
    ).not.toThrow();
  });

  it.each([
    ["standalone", standalonePublishSource, "build-and-publish"],
    ["aggregate", aggregatePublishSource, "publish-snap"],
  ])("rejects single-runner %s publishing", (kind, source, jobName) => {
    const mutated = mutateYaml(source, (workflow) => {
      workflow.jobs[jobName]["runs-on"] = "ubuntu-24.04";
    });
    expect(() => validateSnapPublishWorkflowSource(mutated, { kind })).toThrow(
      /must bind runs-on to matrix.runner/,
    );
  });

  it.each([
    ["standalone", standalonePublishSource, "build-and-publish"],
    ["aggregate", aggregatePublishSource, "publish-snap"],
  ])("rejects non-root source in %s publishing", (kind, source, jobName) => {
    const mutated = mutateYaml(source, (workflow) => {
      jobStep(workflow, jobName, "Build snap").with.path =
        "packages/app-core/packaging/snap";
    });
    expect(() => validateSnapPublishWorkflowSource(mutated, { kind })).toThrow(
      /must build source from the repository root/,
    );
  });

  it.each([
    [
      "standalone beta/edge builds promoted to stable grade",
      standalonePublishSource,
      "standalone",
      "build-and-publish",
      (step) => {
        step.run = step.run.replace(
          "edge|beta) SNAP_GRADE=devel ;;",
          "edge|beta) SNAP_GRADE=stable ;;",
        );
      },
    ],
    [
      "standalone candidate/stable builds left at devel grade",
      standalonePublishSource,
      "standalone",
      "build-and-publish",
      (step) => {
        step.run = step.run.replace(
          "candidate|stable) SNAP_GRADE=stable ;;",
          "candidate|stable) SNAP_GRADE=devel ;;",
        );
      },
    ],
    [
      "aggregate prereleases promoted to stable grade",
      aggregatePublishSource,
      "aggregate",
      "publish-snap",
      (step) => {
        step.run = step.run.replace(
          "true) SNAP_GRADE=devel ;;",
          "true) SNAP_GRADE=stable ;;",
        );
      },
    ],
    [
      "aggregate stable releases left at devel grade",
      aggregatePublishSource,
      "aggregate",
      "publish-snap",
      (step) => {
        step.run = step.run.replace(
          "false) SNAP_GRADE=stable ;;",
          "false) SNAP_GRADE=devel ;;",
        );
      },
    ],
  ])("rejects %s", (_label, source, kind, jobName, mutatePrepare) => {
    const mutated = mutateYaml(source, (workflow) => {
      mutatePrepare(jobStep(workflow, jobName, "Prepare snapcraft.yaml"));
    });
    expect(() => validateSnapPublishWorkflowSource(mutated, { kind })).toThrow(
      /Prepare snapcraft\.yaml step must match/,
    );
  });

  it.each([
    ["standalone", standalonePublishSource, "build-and-publish", "CHANNEL"],
    ["aggregate", aggregatePublishSource, "publish-snap", "IS_PRERELEASE"],
  ])("rejects an unbound %s grade input", (kind, source, jobName, envKey) => {
    const mutated = mutateYaml(source, (workflow) => {
      jobStep(workflow, jobName, "Prepare snapcraft.yaml").env[envKey] =
        "untrusted-literal";
    });
    expect(() => validateSnapPublishWorkflowSource(mutated, { kind })).toThrow(
      /prepare must derive grade from/,
    );
  });

  it("rejects publishing an artifact other than the installed one", () => {
    const mutated = mutateYaml(standalonePublishSource, (workflow) => {
      jobStep(
        workflow,
        "build-and-publish",
        "Publish to Snap Store",
      ).with.snap = "*.snap";
    });
    expect(() =>
      validateSnapPublishWorkflowSource(mutated, { kind: "standalone" }),
    ).toThrow(/publish must consume the tested artifact/);
  });
});

describe("Packaging PR gate", () => {
  it("accepts the develop-targeted frozen validation lane", () => {
    expect(() =>
      validatePackagingWorkflowSource(packagingWorkflowSource),
    ).not.toThrow();
  });

  it.each([
    [
      "main branch target",
      (workflow) => {
        workflow.on.pull_request.branches = ["main"];
      },
    ],
    [
      "omitted Snap publish path",
      (workflow) => {
        workflow.on.pull_request.paths = workflow.on.pull_request.paths.filter(
          (path) => path !== ".github/workflows/snap-publish.yml",
        );
      },
    ],
    [
      "mutable dependency install",
      (workflow) => {
        const install = jobStep(
          workflow,
          "validate",
          "Install validation dependencies from the committed lock",
        );
        install.run = install.run.replace(
          "bun install --frozen-lockfile --ignore-scripts",
          "bun install --ignore-scripts",
        );
      },
    ],
    [
      "disabled contract tests",
      (workflow) => {
        jobStep(workflow, "validate", "Validate Snap packaging contracts").if =
          githubExpression("false");
      },
    ],
  ])("rejects %s", (_label, mutateWorkflow) => {
    const mutated = mutateYaml(packagingWorkflowSource, mutateWorkflow);
    expect(() => validatePackagingWorkflowSource(mutated)).toThrow();
  });
});

describe("Snapcraft hermetic dependency contract", () => {
  it("accepts the pinned frozen runtime build", () => {
    expect(() => validateSnapManifestSource(manifestSource)).not.toThrow();
  });

  it.each([
    [
      "stable source manifest that erases dev-channel grade",
      (source) => source.replace("grade: devel", "grade: stable"),
      /must remain development-grade/,
    ],
    [
      "non-frozen install",
      (source) =>
        source.replace(
          "bun install --frozen-lockfile --ignore-scripts",
          "bun install --ignore-scripts",
        ),
      /exactly one frozen Bun install/,
    ],
    [
      "shell-style comment-only install",
      (source) =>
        source.replace(
          "bun install --frozen-lockfile --ignore-scripts",
          "# bun install --frozen-lockfile --ignore-scripts",
        ),
      /exactly one frozen Bun install/,
    ],
    [
      "JavaScript-looking comment-only install",
      (source) =>
        source.replace(
          "bun install --frozen-lockfile --ignore-scripts",
          "// bun install --frozen-lockfile --ignore-scripts",
        ),
      /exactly one frozen Bun install/,
    ],
    [
      "removed fail-closed shell mode",
      (source) =>
        source.replace(
          "  elizaos-app:\n    after: [node, bun]\n    plugin: nil\n    source: .\n    override-build: |\n      set -eu",
          "  elizaos-app:\n    after: [node, bun]\n    plugin: nil\n    source: .\n    override-build: |\n      echo unsafe",
        ),
      /must start fail closed/,
    ],
    [
      "dead frozen install",
      (source) =>
        source.replace(
          "      bun install --frozen-lockfile --ignore-scripts",
          "      if false; then\n        bun install --frozen-lockfile --ignore-scripts\n      fi",
        ),
      /must execute at top level/,
    ],
    [
      "dead frozen closure block",
      (source) =>
        source.replace(
          '      test -f bun.lock\n      LOCKFILE_SHA256="$(sha256sum bun.lock)"\n      bun install --frozen-lockfile --ignore-scripts\n      test "$(sha256sum bun.lock)" = "$LOCKFILE_SHA256"\n      test -x "$ROOT_NODE_MODULES_BIN/turbo"',
          '      if false; then\n        test -f bun.lock\n        LOCKFILE_SHA256="$(sha256sum bun.lock)"\n        bun install --frozen-lockfile --ignore-scripts\n        test "$(sha256sum bun.lock)" = "$LOCKFILE_SHA256"\n        test -x "$ROOT_NODE_MODULES_BIN/turbo"\n      fi',
        ),
      /must execute at top level/,
    ],
    [
      "reordered lock verification",
      (source) =>
        source.replace(
          '      bun install --frozen-lockfile --ignore-scripts\n      test "$(sha256sum bun.lock)" = "$LOCKFILE_SHA256"',
          '      test "$(sha256sum bun.lock)" = "$LOCKFILE_SHA256"\n      bun install --frozen-lockfile --ignore-scripts',
        ),
      /must execute at top level/,
    ],
    [
      "checksum reassignment",
      (source) =>
        source.replace(
          nodeArchiveLine,
          '      NODE_SHA256="0000000000000000000000000000000000000000000000000000000000000000"\n' +
            nodeArchiveLine,
        ),
      /checksum may be assigned only/,
    ],
    [
      "runtime registry fallback",
      (source) =>
        source.replace(
          '      test -x "$ROOT_NODE_MODULES_BIN/turbo"',
          '      test -x "$ROOT_NODE_MODULES_BIN/turbo"\n      export ELIZA_RUNTIME_COPY_ALLOW_REGISTRY_FETCH=1',
        ),
      /must not enable registry fallback/,
    ],
    [
      "missing arm64 libatomic layout",
      (source) =>
        source.replace(
          "  /usr/lib/aarch64-linux-gnu/libatomic.so.1:\n    symlink: $SNAP/usr/lib/aarch64-linux-gnu/libatomic.so.1\n",
          "",
        ),
      /must define \/usr\/lib\/aarch64-linux-gnu\/libatomic\.so\.1/,
    ],
  ])("rejects %s", (_label, mutate, expectedError) => {
    expect(() => validateSnapManifestSource(mutate(manifestSource))).toThrow(
      expectedError,
    );
  });

  it.each([
    [
      "mutable registry lookup",
      'TAILWIND_URL="$(npm view tailwindcss dist.tarball)"',
      /forbids npm acquisition/,
    ],
    [
      "unverified download",
      'curl -fsSL "https://example.invalid/tailwind.tgz" | tar xz',
      /forbids unverified app dependency download/,
    ],
    ["lockfile deletion", "rm -f bun.lock", /forbids lockfile deletion/],
    [
      "masked patch failure",
      'node "$APP_CORE_SCRIPTS_DIR/patch-deps.mjs" || true',
      /must not mask failures/,
    ],
    ["errexit disablement", "set +e", /must not mask failures/],
  ])("rejects %s", (_label, injected, expectedError) => {
    const mutated = manifestSource.replace(
      "# Vite resolves Tailwind from app-core's workspace install.",
      `${injected}\n\n      # Vite resolves Tailwind from app-core's workspace install.`,
    );
    expect(() => validateSnapManifestSource(mutated)).toThrow(expectedError);
  });
});

describe("Installed Snap smoke contract", () => {
  it("accepts status-preserving offline lifecycle and health proof", () => {
    expect(() =>
      validateInstalledSnapSmokeSource(installedSmokeSource),
    ).not.toThrow();
  });

  it.each([
    [
      "command-substitution status loss",
      (source) =>
        source.replace(
          "run_capture version snap run elizaos-app --version",
          'test "$(snap run elizaos-app --version)" = "$EXPECTED_VERSION"',
        ),
      /must not hide snap run status/,
    ],
    [
      "missing standalone status assertion",
      (source) => source.replace('  test "$command_status" -eq 0', "  true"),
      /must execute/,
    ],
    [
      "online startup",
      (source) =>
        source.replace(
          "sudo snap connect elizaos-app:network-bind",
          "sudo snap connect elizaos-app:network\n  sudo snap connect elizaos-app:network-bind",
        ),
      /must remain offline/,
    ],
    [
      "missing bundled Bun proof",
      (source) =>
        source.replace(
          "run_capture bundled-bun snap run --shell elizaos-app -c '$SNAP/bun/bin/bun --version'",
          "echo skipped-bun",
        ),
      /must execute/,
    ],
    [
      "writable working directory",
      (source) =>
        source.replace('chmod 0555 "$CLEAN_CWD"', 'chmod 0755 "$CLEAN_CWD"'),
      /must execute/,
    ],
    [
      "missing Unicode HOME proof",
      (source) =>
        source.replace(
          /run_capture unicode-home[^\n]+/,
          "echo skipped-unicode-home",
        ),
      /must execute/,
    ],
    [
      "missing rollback",
      (source) =>
        source.replace("sudo snap revert elizaos-app", "echo skipped-revert"),
      /must execute/,
    ],
    [
      "healthy-empty response acceptance",
      (source) => source.replace("body.ready !== true", "false"),
      /must require ready:true/,
    ],
    [
      "missing uninstall",
      (source) =>
        source.replace(
          "printf 'removed\\n' >\"$EVIDENCE_DIR/uninstall.status\"",
          "echo skipped-uninstall",
        ),
      /must execute/,
    ],
  ])("rejects %s", (_label, mutate, expectedError) => {
    expect(() =>
      validateInstalledSnapSmokeSource(mutate(installedSmokeSource)),
    ).toThrow(expectedError);
  });
});

describe("Packaging harness diagnostics", () => {
  it("accepts replayed validator failure output", () => {
    expect(() =>
      validatePackagingHarnessSource(packagingHarnessSource),
    ).not.toThrow();
  });

  it("rejects hidden validator stderr", () => {
    const mutated = packagingHarnessSource.replace(
      'if output="$("$@" 2>&1)"; then',
      'if "$@" >/dev/null 2>&1; then',
    );
    expect(() => validatePackagingHarnessSource(mutated)).toThrow(
      /must not suppress validator diagnostics/,
    );
  });
});
