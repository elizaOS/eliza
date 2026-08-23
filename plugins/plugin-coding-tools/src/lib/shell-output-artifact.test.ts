/**
 * Exercises the real private shell-artifact filesystem lifecycle, including
 * bounded late reads, restart resolution, owner isolation, and tamper faults.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistShellOutputArtifact,
  readShellOutputArtifactPage,
} from "./shell-output-artifact.js";

const OWNER_AGENT = "00000000-0000-4000-8000-000000000001";
const OWNER_CONVERSATION = "00000000-0000-4000-8000-000000000002";

describe("private shell-output artifacts", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;
  let previousTtl: string | undefined;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-artifact-v2-"));
    previousStateDir = process.env.ELIZA_STATE_DIR;
    previousTtl = process.env.SHELL_JOB_TTL_MS;
    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.SHELL_JOB_TTL_MS = "60000";
  });

  afterEach(async () => {
    if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = previousStateDir;
    if (previousTtl === undefined) delete process.env.SHELL_JOB_TTL_MS;
    else process.env.SHELL_JOB_TTL_MS = previousTtl;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  async function publish(stdout: string) {
    return persistShellOutputArtifact({
      command: "printf should-not-enter-manifest",
      cwd: "/private/workspace-path",
      stdout,
      stderr: "stderr-tail\n",
      exitCode: 0,
      timedOut: false,
      signal: null,
      modelCharacterLimit: 50_000,
      modelCharacters: Math.min(50_000, stdout.length),
      ownerAgentId: OWNER_AGENT,
      ownerConversationId: OWNER_CONVERSATION,
    });
  }

  function artifactDirectory(handle: string): string {
    return path.join(stateDir, "coding-tools", "shell-output", handle);
  }

  it("pages a 10 MiB Unicode stream with bounded source reads and exact reassembly", async () => {
    const unit = "🙂alpha界\n";
    const repetitions = Math.ceil((10 * 1024 * 1024) / Buffer.byteLength(unit));
    const source = unit.repeat(repetitions);
    const artifact = await publish(source);
    const manifestText = await fs.readFile(
      path.join(artifactDirectory(artifact.handle), "manifest.json"),
      "utf8",
    );
    expect(manifestText).not.toContain("should-not-enter-manifest");
    expect(manifestText).not.toContain("/private/workspace-path");

    const lateOffset = source.length - 5_000;
    const late = await readShellOutputArtifactPage({
      handle: artifact.handle,
      stream: "stdout",
      offset: lateOffset,
      limit: 2_000,
      requesterAgentId: OWNER_AGENT,
      requesterConversationId: OWNER_CONVERSATION,
    });
    expect(late.ok).toBe(true);
    if (!late.ok) throw new Error(late.message);
    expect(late.value.text).toBe(
      source.slice(late.value.startOffset, late.value.endOffset),
    );
    expect(late.value.sourceBytesRead).toBeLessThanOrEqual(2 * 64 * 1024);
    expect(late.value.sourceSegmentsRead).toBeLessThanOrEqual(2);
    expect(late.value.contentRevision).toBe(artifact.contentRevision);

    let offset = 0;
    let reassembled = "";
    let bytesRead = 0;
    while (offset < source.length) {
      const page = await readShellOutputArtifactPage({
        handle: artifact.handle,
        stream: "stdout",
        offset,
        limit: 20_000,
        requesterAgentId: OWNER_AGENT,
        requesterConversationId: OWNER_CONVERSATION,
      });
      if (!page.ok) throw new Error(page.message);
      expect(page.value.startOffset).toBe(offset);
      expect(page.value.nextOffset).toBeGreaterThan(offset);
      reassembled += page.value.text;
      bytesRead += page.value.sourceBytesRead ?? 0;
      offset = page.value.nextOffset;
    }
    expect(reassembled).toBe(source);
    expect(bytesRead).toBeLessThanOrEqual(Buffer.byteLength(source) * 5);
  }, 60_000);

  it("resolves after restart state loss and denies a different owner", async () => {
    const artifact = await publish("restart-safe\ncontent\n");
    const authorized = await readShellOutputArtifactPage({
      handle: artifact.handle,
      stream: "stdout",
      requesterAgentId: OWNER_AGENT,
      requesterConversationId: OWNER_CONVERSATION,
    });
    expect(authorized).toMatchObject({
      ok: true,
      value: { text: "restart-safe\ncontent\n" },
    });

    const denied = await readShellOutputArtifactPage({
      handle: artifact.handle,
      stream: "stdout",
      requesterAgentId: OWNER_AGENT,
      requesterConversationId: "00000000-0000-4000-8000-000000000099",
    });
    expect(denied).toMatchObject({ ok: false, reason: "unavailable" });
    expect(JSON.stringify(denied)).not.toContain("restart-safe");
  });

  it("fails closed for manifest, segment, symlink, and hard-link tampering", async () => {
    const manifestArtifact = await publish("manifest-tamper");
    const manifestPath = path.join(
      artifactDirectory(manifestArtifact.handle),
      "manifest.json",
    );
    const manifest = JSON.parse(
      await fs.readFile(manifestPath, "utf8"),
    ) as Record<string, unknown>;
    manifest.contentRevision =
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await expectReadCorrupt(manifestArtifact.handle);

    const segmentArtifact = await publish("segment-tamper");
    const segmentPath = path.join(
      artifactDirectory(segmentArtifact.handle),
      "stdout-000000.seg",
    );
    await fs.writeFile(segmentPath, "changed");
    await expectReadCorrupt(segmentArtifact.handle);

    const symlinkArtifact = await publish("symlink-tamper");
    const symlinkPath = path.join(
      artifactDirectory(symlinkArtifact.handle),
      "stdout-000000.seg",
    );
    await fs.unlink(symlinkPath);
    await fs.symlink(
      path.join(artifactDirectory(symlinkArtifact.handle), "stderr-000000.seg"),
      symlinkPath,
    );
    await expectReadCorrupt(symlinkArtifact.handle);

    const hardLinkArtifact = await publish("hardlink-tamper");
    const hardLinkPath = path.join(
      artifactDirectory(hardLinkArtifact.handle),
      "stdout-000000.seg",
    );
    await fs.link(
      hardLinkPath,
      path.join(artifactDirectory(hardLinkArtifact.handle), "extra-link"),
    );
    await expectReadCorrupt(hardLinkArtifact.handle);
  });

  async function expectReadCorrupt(handle: string): Promise<void> {
    const result = await readShellOutputArtifactPage({
      handle,
      stream: "stdout",
      requesterAgentId: OWNER_AGENT,
      requesterConversationId: OWNER_CONVERSATION,
    });
    expect(result).toMatchObject({ ok: false, reason: "corrupt" });
  }
});
