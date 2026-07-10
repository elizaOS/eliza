/**
 * Playwright reporter that materializes a per-test artifact bundle under
 * `<repo>/e2e/<runId>/tests/<id>/` (#15972). For every finished test it copies
 * the attachments Playwright recorded (video, trace, screenshots, the JSONL
 * console/network logs and `state:*` screenshots produced by
 * `./fixtures.ts`, trajectory JSON) into the bundle and writes the
 * `manifest.json` the shared contract defines; on run end it derives the run
 * `index.json`. Consumers are the e2e viewer and the AI review orchestrator —
 * everything they read is written through `scripts/e2e-artifacts/contract.mjs`,
 * never ad hoc.
 *
 * Wired by the app Playwright configs only when `ELIZA_E2E_ARTIFACTS` is set,
 * alongside forced video/trace capture; default runs never load this file.
 * Retried tests overwrite their bundle in place, so the manifest always
 * describes the final attempt (`summary.retry` records how many it took).
 */
import fs from "node:fs";
import path from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import {
  resolveRunId,
  testDir,
  writeRunIndex,
  writeTestManifest,
} from "../../../../scripts/e2e-artifacts/contract.mjs";
import { buildTestId, repoRoot, resolveLane } from "./ids";

interface ManifestArtifact {
  kind: string;
  path: string;
  label?: string;
  stateName?: string;
}

interface PlaywrightAttachment {
  name: string;
  contentType: string;
  path?: string;
  body?: Buffer;
}

/** Filesystem-safe basename for attachment-derived files inside the bundle. */
function safeFileName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || "attachment";
}

function extensionFor(attachment: PlaywrightAttachment): string {
  if (attachment.path) {
    const ext = path.extname(attachment.path);
    if (ext) return ext;
  }
  const byContentType: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "application/json": ".json",
    "application/jsonl": ".jsonl",
    "text/plain": ".txt",
    "application/zip": ".zip",
  };
  return byContentType[attachment.contentType] ?? ".bin";
}

/**
 * Maps a Playwright attachment to its bundle file name + contract kind.
 * `state:<name>` and `trajectory:<file>` are the naming conventions the
 * sibling fixtures use; everything unrecognized keeps its content as kind
 * "other" so no attachment is ever silently dropped.
 */
function classifyAttachment(
  attachment: PlaywrightAttachment,
  ordinal: number,
): { kind: string; fileName: string; label?: string; stateName?: string } {
  const suffix = ordinal > 0 ? `-${ordinal + 1}` : "";
  if (attachment.name === "video") {
    return { kind: "video", fileName: `video${suffix}.webm` };
  }
  if (attachment.name === "trace") {
    return { kind: "trace", fileName: `trace${suffix}.zip` };
  }
  if (attachment.name === "screenshot") {
    return {
      kind: "screenshot",
      fileName: `screenshot${suffix}${extensionFor(attachment)}`,
    };
  }
  if (attachment.name.startsWith("state:")) {
    const stateName = attachment.name.slice("state:".length);
    return {
      kind: "state-screenshot",
      fileName: `state-${safeFileName(stateName)}${suffix}${extensionFor(attachment)}`,
      label: stateName,
      stateName,
    };
  }
  if (attachment.name === "console-log") {
    return { kind: "console-log", fileName: `console-log${suffix}.jsonl` };
  }
  if (attachment.name === "network-log") {
    return { kind: "network-log", fileName: `network-log${suffix}.jsonl` };
  }
  if (attachment.name.startsWith("trajectory:")) {
    const source = attachment.name.slice("trajectory:".length);
    return {
      kind: "trajectory",
      fileName: `trajectory-${safeFileName(source)}`,
      label: source,
    };
  }
  return {
    kind: "other",
    fileName: `${safeFileName(attachment.name)}${suffix}${extensionFor(attachment)}`,
    label: attachment.name,
  };
}

class E2eArtifactsReporter implements Reporter {
  private readonly runId = resolveRunId();
  private readonly lane = resolveLane();

  printsToStdio(): boolean {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const id = buildTestId(this.lane, test.location.file, test.titlePath());
    const dir = testDir(repoRoot, this.runId, id);
    fs.mkdirSync(dir, { recursive: true });

    const artifacts: ManifestArtifact[] = [];
    // Duplicate names (several plain screenshots, one state per retry, …) get
    // ordinal suffixes so a later copy never clobbers an earlier one.
    const nameCounts = new Map<string, number>();
    for (const attachment of result.attachments as PlaywrightAttachment[]) {
      const ordinal = nameCounts.get(attachment.name) ?? 0;
      nameCounts.set(attachment.name, ordinal + 1);
      const entry = this.materialize(dir, attachment, ordinal);
      if (entry) artifacts.push(entry);
    }

    const startedAt = result.startTime.toISOString();
    const finishedAt = new Date(
      result.startTime.getTime() + result.duration,
    ).toISOString();
    writeTestManifest(dir, {
      id,
      runId: this.runId,
      lane: this.lane,
      project: test.parent.project()?.name ?? "",
      file: path.relative(repoRoot, test.location.file),
      title: test
        .titlePath()
        .filter((segment) => segment.length > 0)
        .join(" > "),
      status: result.status,
      durationMs: result.duration,
      startedAt,
      finishedAt,
      artifacts,
      summary: {
        retry: result.retry,
        expectedStatus: test.expectedStatus,
        errorMessage: result.error?.message ?? null,
      },
    });
  }

  async onEnd(_result: FullResult): Promise<void> {
    writeRunIndex(repoRoot, this.runId);
  }

  private materialize(
    dir: string,
    attachment: PlaywrightAttachment,
    ordinal: number,
  ): ManifestArtifact | null {
    const { kind, fileName, label, stateName } = classifyAttachment(
      attachment,
      ordinal,
    );
    const target = path.join(dir, fileName);
    if (attachment.path) {
      // Video/trace files can lag the test's end by a beat while Playwright
      // finalizes them; an absent file here is a real capture failure and the
      // manifest must not claim an artifact that does not exist.
      if (!fs.existsSync(attachment.path)) {
        return null;
      }
      fs.copyFileSync(attachment.path, target);
    } else if (attachment.body !== undefined) {
      fs.writeFileSync(target, attachment.body);
    } else {
      // Playwright attachments carry either a path or a body; one with
      // neither has no content to bundle.
      return null;
    }
    return {
      kind,
      path: fileName,
      ...(label !== undefined ? { label } : {}),
      ...(stateName !== undefined ? { stateName } : {}),
    };
  }
}

export default E2eArtifactsReporter;
