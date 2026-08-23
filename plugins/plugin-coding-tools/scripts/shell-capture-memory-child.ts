/**
 * Measures the real encrypted foreground capture pipeline in a fresh process
 * while verifying the published artifact by bounded authenticated page reads.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { readShellOutputArtifactPage } from "../src/lib/shell-output-artifact.ts";
import { ForegroundShellCapture } from "../src/lib/shell-streaming-capture.ts";

const targetBytes = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
  throw new Error("expected one non-negative byte target");
}

const ownerAgentId = "00000000-0000-4000-8000-000000000001";
const ownerConversationId = "00000000-0000-4000-8000-000000000002";
const secret = "marigold9-bounded-memory-cross-chunk-secret";
const stateDir = await fs.mkdtemp(
  path.join(os.tmpdir(), "shell-memory-child-"),
);
process.env.ELIZA_STATE_DIR = stateDir;
process.env.SHELL_JOB_TTL_MS = "60000";

const runtime = {
  character: { settings: { secrets: { TEST_SECRET: secret } } },
  redactSecrets: (text: string) =>
    text.replaceAll(secret, "[REDACTED:TEST_SECRET]"),
} as unknown as IAgentRuntime;

const warmup = await ForegroundShellCapture.create();
const warmupChunk = "warmup-row\n".repeat(4096);
let warmupBytes = 0;
while (warmupBytes < 1024 * 1024) {
  warmupBytes += Buffer.byteLength(warmupChunk);
  if (!warmup.write("stdout", warmupChunk)) {
    await new Promise<void>((resolve) => warmup.onDrain("stdout", resolve));
  }
}
await warmup.finalize(runtime, {
  exitCode: 0,
  timedOut: false,
  signal: null,
  ownerAgentId,
  ownerConversationId,
});

const expected = createHash("sha256");
const capture = await ForegroundShellCapture.create();
let sourceBytes = 0;
globalThis.gc?.();
const baseline = process.memoryUsage();
let peakRss = baseline.rss;
let peakHeap = baseline.heapUsed;
const sample = setInterval(() => {
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
}, 2);
sample.unref();
const startedAt = performance.now();

async function write(text: string): Promise<void> {
  sourceBytes += Buffer.byteLength(text);
  if (!capture.write("stdout", text)) {
    await new Promise<void>((resolve) => capture.onDrain("stdout", resolve));
  }
}

try {
  const secretLeft = secret.slice(0, 17);
  const secretRight = secret.slice(17);
  await write(`prefix:${secretLeft}`);
  await write(`${secretRight}\n-----BEGIN PRI`);
  await write(
    "VATE KEY-----\naGVsbG8tc2VjcmV0LWtleQ==\n-----END PRIVATE KEY-----\n",
  );
  expected.update(
    "prefix:[REDACTED:TEST_SECRET]\n-----BEGIN PRIVATE KEY-----\n…redacted…\n-----END PRIVATE KEY-----\n",
  );

  const filler = "🙂alpha界 bounded-memory-row-0123456789\n".repeat(1024);
  const fillerBytes = Buffer.from(filler);
  while (sourceBytes < targetBytes) {
    await write(filler);
    expected.update(fillerBytes);
  }

  const finalized = await capture.finalize(runtime, {
    exitCode: 0,
    timedOut: false,
    signal: null,
    ownerAgentId,
    ownerConversationId,
  });
  const observed = createHash("sha256");
  let offset = 0;
  let pageBytesRead = 0;
  while (offset < finalized.artifact.stdout.characters) {
    const page = await readShellOutputArtifactPage({
      handle: finalized.artifact.handle,
      stream: "stdout",
      offset,
      limit: 20_000,
      requesterAgentId: ownerAgentId,
      requesterConversationId: ownerConversationId,
    });
    if (!page.ok) throw new Error(page.message);
    observed.update(page.value.text);
    pageBytesRead += page.value.sourceBytesRead ?? 0;
    if (page.value.nextOffset <= offset)
      throw new Error("artifact page traversal did not advance");
    offset = page.value.nextOffset;
  }
  clearInterval(sample);
  const memory = process.memoryUsage();
  peakRss = Math.max(peakRss, memory.rss);
  peakHeap = Math.max(peakHeap, memory.heapUsed);
  const durationMs = performance.now() - startedAt;
  const expectedSha256 = expected.digest("hex");
  const observedSha256 = observed.digest("hex");
  if (expectedSha256 !== observedSha256)
    throw new Error("artifact reassembly hash does not match redacted source");
  process.stdout.write(
    `${JSON.stringify({
      targetBytes,
      sourceBytes,
      storedBytes: finalized.artifact.stdout.bytes,
      pageBytesRead,
      durationMs,
      throughputMiBPerSecond: sourceBytes / (1024 * 1024) / (durationMs / 1000),
      baselineRss: baseline.rss,
      baselineHeap: baseline.heapUsed,
      peakRss,
      peakHeap,
      expectedSha256,
      observedSha256,
    })}\n`,
  );
} finally {
  clearInterval(sample);
  await fs.rm(stateDir, { recursive: true, force: true });
}
