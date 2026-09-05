/**
 * Exercises voice evidence finalization with real ffmpeg/ffprobe processes,
 * including revision, correlation, missing-loopback, and silent-audio reds.
 *
 * The media suites require ffmpeg and ffprobe on PATH (or via
 * ELIZA_FFMPEG_BIN / ELIZA_FFPROBE_BIN / the packaged statics). Where the
 * runner has neither they report an explicit skip; the snapshot suites and the
 * fail-closed resolution contract run unconditionally.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertLiveMatrixReport,
  correlateAudioWindow,
  finalizeDesktopVoiceEvidence,
  finalizeWebVoiceEvidence,
  findMediaTools,
  inspectAudibleMp4,
  resolveMediaTools,
  snapshotEvidenceDirectory,
  snapshotEvidenceFile,
} from "./voice-evidence-media.mjs";

// The media suites drive real ffmpeg/ffprobe processes. Runners in the
// zero-key lanes install neither, and a hard failure there takes out the whole
// required gate for a tool the lane never claimed to provision. Skip those
// suites explicitly instead — the snapshot suites and the fail-closed contract
// below still run everywhere, and any runner that DOES have the tools (every
// evidence-producing lane, after `bun run evidence:install-tools`) runs the
// full media coverage unchanged.
const mediaTools = findMediaTools();
const describeWithMedia = describe.skipIf(!mediaTools);

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-evidence-media-"));
  roots.push(root);
  return root;
}

test("evidence snapshot remains bound when the live source changes", () => {
  const root = fixtureRoot();
  const source = path.join(root, "live-artifact.bin");
  const snapshotRoot = path.join(root, "snapshot");
  fs.mkdirSync(snapshotRoot);
  fs.writeFileSync(source, "validated bytes");

  const snapshot = snapshotEvidenceFile(source, snapshotRoot, "artifact.bin");
  fs.writeFileSync(source, "bytes changed after capture");

  expect(fs.readFileSync(snapshot, "utf8")).toBe("validated bytes");
});

test("evidence snapshot rejects symlinks and concurrent source mutation", () => {
  const root = fixtureRoot();
  const source = path.join(root, "live-artifact.bin");
  const symlink = path.join(root, "live-artifact-link.bin");
  const snapshotRoot = path.join(root, "snapshot");
  fs.mkdirSync(snapshotRoot);
  fs.writeFileSync(source, "validated bytes");
  fs.symlinkSync(source, symlink);

  expect(() =>
    snapshotEvidenceFile(symlink, snapshotRoot, "symlink.bin"),
  ).toThrow(/regular file/);

  const originalRead = fs.readSync;
  let mutated = false;
  const readSpy = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
    if (!mutated) {
      mutated = true;
      fs.writeFileSync(source, "tampered bytes!");
    }
    return originalRead(...args);
  });
  try {
    expect(() =>
      snapshotEvidenceFile(source, snapshotRoot, "mutated.bin"),
    ).toThrow(/changed while/);
    expect(fs.existsSync(path.join(snapshotRoot, "mutated.bin"))).toBe(false);
  } finally {
    readSpy.mockRestore();
  }
});

test("evidence directory snapshot rejects symlink aliases and owns its bytes", () => {
  const root = fixtureRoot();
  const source = path.join(root, "live-results");
  const nested = path.join(source, "nested");
  const snapshotRoot = path.join(root, "snapshot");
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(snapshotRoot);
  fs.writeFileSync(path.join(nested, "result.json"), "original result");

  const snapshot = snapshotEvidenceDirectory(source, snapshotRoot, "results");
  fs.writeFileSync(path.join(nested, "result.json"), "later mutation");
  expect(
    fs.readFileSync(path.join(snapshot, "nested", "result.json"), "utf8"),
  ).toBe("original result");

  fs.symlinkSync(nested, path.join(source, "alias"));
  expect(() =>
    snapshotEvidenceDirectory(source, snapshotRoot, "rejected"),
  ).toThrow(/symlink entry/);
  expect(fs.existsSync(path.join(snapshotRoot, "rejected"))).toBe(false);
});

test("media tool resolution fails closed and matches the skip probe", () => {
  if (mediaTools) {
    expect(resolveMediaTools()).toEqual(mediaTools);
    expect(mediaTools.ffmpeg).toBeTruthy();
    expect(mediaTools.ffprobe).toBeTruthy();
    return;
  }
  // Evidence production must never silently continue without the tools; only
  // the media suites above degrade, and they degrade to an explicit skip.
  expect(() => resolveMediaTools()).toThrow(/evidence:install-tools/);
});

// A lane that claims to produce media evidence must not be allowed to degrade
// to a skip: a present-but-broken ffmpeg (wrong arch, missing shared library,
// nonzero `-version` exit) probes exactly like an absent one. Provisioned
// lanes export ELIZA_REQUIRE_MEDIA_TOOLS=1 so a lost or corrupted install
// fails loudly instead of turning the media contracts into silent skips.
test.skipIf(process.env.ELIZA_REQUIRE_MEDIA_TOOLS !== "1")(
  "this lane provisioned working ffmpeg/ffprobe",
  () => {
    expect(mediaTools).toBeTruthy();
  },
);

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}

function video(file, tools, seconds = 2) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  run(tools.ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=orange:s=320x240:d=${seconds}`,
    "-c:v",
    path.extname(file) === ".webm" ? "libvpx" : "libx264",
    file,
  ]);
}

function audio(file, tools, frequency = 440, seconds = 1) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  run(tools.ffmpeg, [
    "-y",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:duration=${seconds}`,
    "-af",
    `volume=0.5+0.4*sin(2*PI*t*${frequency / 100}):eval=frame`,
    file,
  ]);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function textualEvidence(root) {
  const textExtensions = new Set([".json", ".log", ".md", ".txt", ".xml"]);
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else if (textExtensions.has(path.extname(entry.name))) files.push(file);
    }
  }
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function allEvidenceBytes(root) {
  const chunks = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else chunks.push(fs.readFileSync(file));
    }
  }
  return Buffer.concat(chunks);
}

function decodedAudioSamples(file, tools) {
  const result = spawnSync(
    tools.ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-t",
      "1",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "f32le",
      "-",
    ],
    { encoding: null, maxBuffer: 8 * 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(0);
  const samples = [];
  for (let offset = 0; offset + 4 <= result.stdout.length; offset += 4) {
    samples.push(result.stdout.readFloatLE(offset));
  }
  expect(samples.length).toBeGreaterThanOrEqual(4_000);
  return samples;
}

function expectBlackVideo(file, tools) {
  const result = spawnSync(
    tools.ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      "-frames:v",
      "1",
      "-vf",
      "scale=32:32",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "-",
    ],
    { encoding: null, maxBuffer: 1024 * 1024 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(0);
  expect(result.stdout.length).toBe(32 * 32 * 3);
  const maxChannel = result.stdout.reduce(
    (maximum, channel) => Math.max(maximum, channel),
    0,
  );
  expect(maxChannel).toBeLessThanOrEqual(8);
}

function spectralMagnitude(samples, frequencyHz, sampleRateHz = 8_000) {
  let real = 0;
  let imaginary = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const phase = (2 * Math.PI * frequencyHz * index) / sampleRateHz;
    real += samples[index] * Math.cos(phase);
    imaginary -= samples[index] * Math.sin(phase);
  }
  return (2 * Math.hypot(real, imaginary)) / samples.length;
}

function expectOnlyProjectedTone(
  file,
  tools,
  projectedFrequencyHz,
  privateFrequenciesHz,
) {
  const samples = decodedAudioSamples(file, tools);
  const projectedMagnitude = spectralMagnitude(samples, projectedFrequencyHz);
  expect(projectedMagnitude).toBeGreaterThan(0.01);
  for (const privateFrequencyHz of privateFrequenciesHz) {
    expect(
      spectralMagnitude(samples, privateFrequencyHz) / projectedMagnitude,
    ).toBeLessThan(0.03);
  }
}

function expectManifestIntegrity(outDir, result) {
  const persisted = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  expect(persisted).toEqual(result.manifest);
  for (const artifact of persisted.artifacts) {
    const file = path.join(outDir, artifact.path);
    const bytes = fs.readFileSync(file);
    expect(bytes.length).toBe(artifact.bytes);
    expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(
      artifact.sha256,
    );
  }
}

function evidenceStagingSiblings(outDir) {
  const prefix = `.${path.basename(outDir)}.voice-evidence-staging-`;
  return fs
    .readdirSync(path.dirname(outDir))
    .filter((entry) => entry.startsWith(prefix));
}

function currentHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function webFixture(root, tools) {
  const captureStartedAtMs = Date.now() - 2_000;
  const live = path.join(root, "results", "live-roundtrip");
  const attachments = path.join(live, "attachments");
  video(path.join(live, "video.webm"), tools, 3);
  fs.writeFileSync(path.join(live, "trace.zip"), "trace");
  const micPayload = path.join(attachments, "voice-live-input-deadbeef.wav");
  const ttsPayload = path.join(attachments, "voice-live-tts-cafebabe.wav");
  audio(micPayload, tools, 440);
  audio(ttsPayload, tools, 660);
  writeJson(path.join(attachments, "voice-live-trajectory-abc123.json"), {
    trajectory: {
      id: "trajectory-1",
      roomId: "room-1",
      metadata: { messageId: "user-message-1" },
    },
    llmCalls: [{ model: "test-model", response: "The test response." }],
  });
  writeJson(path.join(attachments, "voice-live-network-abc123.json"), {
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    audioOutput: {
      reference: {
        startedAt: new Date(captureStartedAtMs + 200).toISOString(),
        endedAt: new Date(captureStartedAtMs + 800).toISOString(),
      },
      ttsStartedAt: new Date(captureStartedAtMs + 1_500).toISOString(),
    },
    asr: { status: 200 },
    agent: {
      status: 200,
      roomId: "room-1",
      messageId: "message-1",
      userMessageId: "user-message-1",
      trajectoryId: "trajectory-1",
    },
    tts: { status: 200 },
  });
  const failures = path.join(root, "failures");
  for (const name of [
    "mic-permission-denied",
    "silent-empty-capture",
    "tts-dropped-mid-stream",
  ]) {
    video(path.join(failures, name, "video.webm"), tools);
  }
  const loopback = path.join(root, "system-loopback.wav");
  run(tools.ffmpeg, [
    "-y",
    "-v",
    "error",
    "-i",
    micPayload,
    "-i",
    ttsPayload,
    "-filter_complex",
    "[0:a]adelay=200:all=1[reference];[1:a]adelay=1500:all=1[tts];[reference][tts]amix=inputs=2:duration=longest:normalize=0[out]",
    "-map",
    "[out]",
    loopback,
  ]);
  const loopbackClock = path.join(root, "system-loopback-clock.json");
  writeJson(loopbackClock, {
    source: "pulse-monitor",
    startedAtMs: captureStartedAtMs,
    finishedAtMs: captureStartedAtMs + 3_000,
  });
  const backend = path.join(root, "backend.log");
  fs.writeFileSync(backend, "[voice] live route complete\n");
  const matrix = path.join(root, "voice-matrix.json");
  const revision = currentHead();
  const sessionId = "voice-web-live-session-123456";
  writeJson(matrix, {
    schema: "eliza_voice_live_matrix_v2",
    revision,
    sessionId,
    mode: "run",
    selection: { filterCount: 1, matched: 1, errorCode: null },
    summary: { pass: 1, fail: 0, pending: 0, skip: 0 },
    cells: [
      {
        id: "web.live.railway-roundtrip",
        platform: "web",
        status: "pass",
        probe: { available: true, code: "WEB_LIVE_READY" },
        execution: {
          exitCode: 0,
          signalCode: null,
          code: "COMMAND_PASSED",
        },
      },
    ],
  });
  return {
    resultsDir: path.join(root, "results"),
    failureResultsDir: failures,
    systemLoopback: loopback,
    loopbackClock,
    backendLog: backend,
    matrixReport: matrix,
    expectedRevision: revision,
    expectedSession: sessionId,
    outDir: path.join(root, "final"),
    tools,
  };
}

describeWithMedia("web voice media evidence", () => {
  test("publishes only duration-projected audio in a revision-bound MP4", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    const trajectory = path.join(
      fixture.resultsDir,
      "live-roundtrip",
      "attachments",
      "voice-live-trajectory-abc123.json",
    );
    const network = path.join(
      fixture.resultsDir,
      "live-roundtrip",
      "attachments",
      "voice-live-network-abc123.json",
    );
    const canaries = {
      response: "MODEL_RESPONSE_CANARY_web-private-text",
      room: "ROOM_CANARY_web-4455",
      message: "MESSAGE_CANARY_web-5566",
      trajectory: "TRAJECTORY_CANARY_web-6677",
      backend: "BACKEND_CANARY_web-7788",
      mediaMetadata: "MEDIA_METADATA_CANARY_web-8899",
    };
    fs.appendFileSync(fixture.systemLoopback, canaries.mediaMetadata);
    for (const file of [
      path.join(
        fixture.resultsDir,
        "live-roundtrip",
        "attachments",
        "voice-live-input-deadbeef.wav",
      ),
      path.join(
        fixture.resultsDir,
        "live-roundtrip",
        "attachments",
        "voice-live-tts-cafebabe.wav",
      ),
      ...[
        "mic-permission-denied",
        "silent-empty-capture",
        "tts-dropped-mid-stream",
      ].map((name) => path.join(fixture.failureResultsDir, name, "video.webm")),
    ]) {
      fs.appendFileSync(file, canaries.mediaMetadata);
    }
    writeJson(trajectory, {
      trajectory: {
        id: canaries.trajectory,
        roomId: canaries.room,
        metadata: { messageId: canaries.message },
      },
      llmCalls: [{ model: "private-model", response: canaries.response }],
    });
    const networkValue = JSON.parse(fs.readFileSync(network, "utf8"));
    networkValue.agent.roomId = canaries.room;
    networkValue.agent.userMessageId = canaries.message;
    networkValue.agent.trajectoryId = canaries.trajectory;
    writeJson(network, networkValue);
    fs.writeFileSync(fixture.backendLog, `${canaries.backend}\n`);

    const result = finalizeWebVoiceEvidence(fixture);
    expect(result.manifest.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(result.manifest.privacy).toEqual({
      publicAudio: "non-intelligible-duration-only-fixed-tone",
      privateAudioPublished: false,
      sourceFeaturePublished: "duration-only",
    });
    expect(result.manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "privacy-safe-black-video-plus-projected-loopback-tone",
        }),
        expect.objectContaining({
          role: "privacy-safe-black-failure-path-video",
        }),
      ]),
    );
    expect(inspectAudibleMp4(result.mp4, tools).maxVolumeDb).toBeGreaterThan(
      -60,
    );
    expect(result.manifest.proof).toEqual(
      expect.objectContaining({
        modelResponsePresent: true,
        trajectoryMatched: true,
        roomMatched: true,
        messageMatched: true,
        backendEvidencePresent: true,
        publicAudioProjectedFromDurationOnly: true,
        privateAudioPublished: false,
      }),
    );
    const artifactRoles = result.manifest.artifacts.map(({ role }) => role);
    expect(artifactRoles).not.toEqual(
      expect.arrayContaining([
        "live-llm-trajectory",
        "frontend-network",
        "frontend-trace",
        "backend-log",
      ]),
    );
    const serialized = textualEvidence(fixture.outDir);
    for (const canary of Object.values(canaries)) {
      expect(serialized).not.toContain(canary);
      expect(allEvidenceBytes(fixture.outDir).includes(canary)).toBe(false);
    }
    const projectedFrequencyHz =
      result.manifest.media.acousticProjection.frequencyHz;
    expect(
      spectralMagnitude(
        decodedAudioSamples(
          path.join(
            fixture.resultsDir,
            "live-roundtrip",
            "attachments",
            "voice-live-input-deadbeef.wav",
          ),
          tools,
        ),
        440,
      ),
    ).toBeGreaterThan(0.01);
    for (const artifact of result.manifest.artifacts.filter(
      ({ role }) =>
        role.includes("projected") &&
        (role.includes("tone") || role.includes("video")),
    )) {
      expectOnlyProjectedTone(
        path.join(fixture.outDir, artifact.path),
        tools,
        projectedFrequencyHz,
        [440, 660],
      );
    }
    for (const artifact of result.manifest.artifacts.filter(({ role }) =>
      role.includes("video"),
    )) {
      expectBlackVideo(path.join(fixture.outDir, artifact.path), tools);
    }
    const projectedMic = result.manifest.artifacts.find(({ role }) =>
      role.includes("projected-microphone"),
    );
    const projectedTts = result.manifest.artifacts.find(({ role }) =>
      role.includes("projected-tts"),
    );
    expect(projectedMic.sha256).toBe(projectedTts.sha256);
    expectManifestIntegrity(fixture.outDir, result);
    expect(evidenceStagingSiblings(fixture.outDir)).toEqual([]);
  });

  test("refuses payload-only evidence without system loopback", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    fs.unlinkSync(fixture.systemLoopback);
    expect(() => finalizeWebVoiceEvidence(fixture)).toThrow(
      /Missing system loopback/,
    );
  });

  test("refuses a trajectory that is not correlated to the network turn", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    const trajectory = path.join(
      fixture.resultsDir,
      "live-roundtrip",
      "attachments",
      "voice-live-trajectory-abc123.json",
    );
    writeJson(trajectory, {
      trajectory: { id: "concurrent-trajectory" },
      llmCalls: [{ model: "test-model", response: "foreign response" }],
    });
    expect(() => finalizeWebVoiceEvidence(fixture)).toThrow(
      /does not match the network correlation id/,
    );
  });

  test("refuses a failed live route and a silent system capture", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    const network = path.join(
      fixture.resultsDir,
      "live-roundtrip",
      "attachments",
      "voice-live-network-abc123.json",
    );
    const value = JSON.parse(fs.readFileSync(network, "utf8"));
    value.tts.status = 503;
    writeJson(network, value);
    expect(() => finalizeWebVoiceEvidence(fixture)).toThrow(
      /tts status is not successful/,
    );

    value.tts.status = 200;
    writeJson(network, value);
    run(tools.ffmpeg, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono:d=2",
      "-filter_complex",
      "[0:a][1:a]concat=n=2:v=0:a=1[a]",
      "-map",
      "[a]",
      fixture.systemLoopback,
    ]);
    expect(() => finalizeWebVoiceEvidence(fixture)).toThrow(/silent/);
  });

  test("refuses evidence requested for a different revision", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    expect(() =>
      finalizeWebVoiceEvidence({
        ...fixture,
        expectedRevision: "0".repeat(40),
      }),
    ).toThrow(/does not match HEAD/);
    expect(fs.existsSync(fixture.outDir)).toBe(false);
    expect(evidenceStagingSiblings(fixture.outDir)).toEqual([]);
  });

  test.each([
    ["revision", "0".repeat(40)],
    ["sessionId", "replayed-voice-session"],
    ["cell", "web.failure-paths"],
    ["execution", "COMMAND_EXIT_NONZERO"],
  ])("refuses a matrix report with mismatched %s authority", (field, value) => {
    const revision = currentHead();
    const sessionId = "voice-web-live-session-123456";
    const matrix = {
      schema: "eliza_voice_live_matrix_v2",
      revision,
      sessionId,
      mode: "run",
      selection: { filterCount: 1, matched: 1, errorCode: null },
      summary: { pass: 1, fail: 0, pending: 0, skip: 0 },
      cells: [
        {
          id: "web.live.railway-roundtrip",
          platform: "web",
          status: "pass",
          probe: { available: true, code: "WEB_LIVE_READY" },
          execution: {
            exitCode: 0,
            signalCode: null,
            code: "COMMAND_PASSED",
          },
        },
      ],
    };
    if (field === "cell") matrix.cells[0].id = value;
    else if (field === "execution") matrix.cells[0].execution.code = value;
    else matrix[field] = value;

    expect(() => assertLiveMatrixReport(matrix, revision, sessionId)).toThrow(
      /revision- and session-bound Railway cell pass/,
    );
  });

  test("removes staging after a transcode fails and publishes nothing", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    fs.writeFileSync(
      path.join(
        fixture.failureResultsDir,
        "silent-empty-capture",
        "video.webm",
      ),
      "injected failure after the first failure-path transcode",
    );

    expect(() => finalizeWebVoiceEvidence(fixture)).toThrow(
      /silence failure recording transcode failed/,
    );
    expect(fs.existsSync(fixture.outDir)).toBe(false);
    expect(evidenceStagingSiblings(fixture.outDir)).toEqual([]);
  });

  test("rejects a staged manifest that diverges from the verified result", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    const originalWrite = fs.writeFileSync;
    let mutated = false;
    const writeSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((file, data, ...rest) => {
        originalWrite(file, data, ...rest);
        if (
          !mutated &&
          typeof file === "string" &&
          file.endsWith("voice-web-evidence-manifest.json")
        ) {
          mutated = true;
          const manifest = JSON.parse(String(data));
          manifest.revision = "0".repeat(40);
          originalWrite(file, `${JSON.stringify(manifest, null, 2)}\n`);
        }
      });
    try {
      expect(() => finalizeWebVoiceEvidence(fixture)).toThrow(
        /manifest is incomplete or privacy-unsafe/,
      );
    } finally {
      writeSpy.mockRestore();
    }
    expect(mutated).toBe(true);
    expect(fs.existsSync(fixture.outDir)).toBe(false);
    expect(evidenceStagingSiblings(fixture.outDir)).toEqual([]);
  });

  test("refuses root, existing, and symlink publication destinations", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const fixture = webFixture(root, tools);
    const empty = path.join(root, "empty-publication");
    const nonempty = path.join(root, "nonempty-publication");
    const target = path.join(root, "symlink-target");
    const symlink = path.join(root, "symlink-publication");
    fs.mkdirSync(empty);
    fs.mkdirSync(nonempty);
    fs.writeFileSync(path.join(nonempty, "existing.txt"), "owned by caller");
    fs.mkdirSync(target);
    fs.symlinkSync(target, symlink, "dir");

    expect(() =>
      finalizeWebVoiceEvidence({
        ...fixture,
        outDir: path.parse(root).root,
      }),
    ).toThrow(/cannot be a filesystem root/);
    expect(() =>
      finalizeWebVoiceEvidence({ ...fixture, outDir: empty }),
    ).toThrow(/must not already exist/);
    expect(() =>
      finalizeWebVoiceEvidence({ ...fixture, outDir: nonempty }),
    ).toThrow(/must not already exist/);
    expect(() =>
      finalizeWebVoiceEvidence({ ...fixture, outDir: symlink }),
    ).toThrow(/cannot be a symlink/);
    expect(fs.readFileSync(path.join(nonempty, "existing.txt"), "utf8")).toBe(
      "owned by caller",
    );
    expect(fs.readdirSync(target)).toEqual([]);
  });

  test("refuses an MP4 without an audio stream", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const file = path.join(root, "video-only.mp4");
    video(file, tools);
    expect(() => inspectAudibleMp4(file, tools)).toThrow(/no audio stream/);
  });
});

describeWithMedia("packaged desktop voice media evidence", () => {
  test("requires real mic mode and separate audible speaker loopback", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const report = path.join(root, "desktop-report.json");
    writeJson(report, {
      revision: currentHead(),
      sessionId: "voice-session-123456",
      capturedAt: new Date().toISOString(),
      packagedRevision: currentHead(),
      rendererBuildId: "renderer-build-1",
      report: {
        overall: "pass",
        platform: "desktop",
        mode: "mic-capture",
        startedAt: new Date(Date.now() - 1_000).toISOString(),
        finishedAt: new Date().toISOString(),
        ttsRoute: "/api/tts/local-inference",
        sendBackend: "local-inference:eliza-1",
        stages: [
          {
            stage: "asr",
            status: "pass",
            detail: {
              captureStartedAt: new Date(Date.now() - 1_000).toISOString(),
              captureFinishedAt: new Date().toISOString(),
              referenceStartedAt: new Date(Date.now() - 900).toISOString(),
              referenceFinishedAt: new Date(Date.now() - 200).toISOString(),
              inputDeviceId: "browser-mic-id",
              inputDeviceLabel: "USB test microphone",
            },
          },
          {
            stage: "send",
            status: "pass",
            detail: {
              conversationId: "desktop-conversation-1",
              userMessageId: "desktop-user-message-1",
            },
          },
          {
            stage: "tts",
            status: "pass",
            detail: {
              playbackStartedAt: new Date(Date.now() - 900).toISOString(),
              playbackFinishedAt: new Date(Date.now() - 100).toISOString(),
              outputDeviceId: "browser-speaker-id",
              played: true,
              outputObserved: true,
            },
          },
        ],
      },
    });
    const trajectory = path.join(root, "desktop-trajectory.json");
    writeJson(trajectory, {
      trajectory: {
        id: "desktop-trajectory-1",
        metadata: {
          conversationId: "desktop-conversation-1",
          messageId: "desktop-user-message-1",
        },
      },
      llmCalls: [{ model: "eliza-1", response: "It is noon." }],
    });
    const backendLog = path.join(root, "desktop-backend.log");
    fs.writeFileSync(backendLog, "[voice] local ASR and TTS complete\n");
    const screenRecording = path.join(root, "desktop-screen.mp4");
    const microphoneAudio = path.join(root, "desktop-mic.wav");
    const speakerLoopbackAudio = path.join(root, "desktop-speaker.wav");
    const captureProvenance = path.join(
      root,
      "desktop-capture-provenance.json",
    );
    const microphonePayload = path.join(root, "app-input.wav");
    const ttsPayload = path.join(root, "returned-tts.wav");
    const referencePayload = path.join(root, "known-reference.wav");
    video(screenRecording, tools, 3);
    audio(microphoneAudio, tools, 440, 3);
    const microphoneCanary = "PHYSICAL_MIC_CANARY_private-ambient-speech";
    fs.appendFileSync(microphoneAudio, microphoneCanary);
    audio(speakerLoopbackAudio, tools, 440, 3);
    audio(microphonePayload, tools, 440, 3);
    audio(ttsPayload, tools, 440, 3);
    audio(referencePayload, tools, 440, 3);
    const mediaMetadataCanary = "MEDIA_METADATA_CANARY_desktop-private";
    for (const file of [
      speakerLoopbackAudio,
      microphonePayload,
      ttsPayload,
      referencePayload,
    ]) {
      fs.appendFileSync(file, mediaMetadataCanary);
    }
    writeJson(captureProvenance, {
      kind: "physical-hardware",
      revision: currentHead(),
      sessionId: "voice-session-123456",
      microphone: {
        kind: "physical-microphone",
        device: "USB test microphone",
        enumeratedLabel: "USB test microphone",
        classification: "operator-selected-enumerated-nonvirtual-endpoint",
        classifier: "eliza-voice-physical-microphone-v2",
        platform: "darwin",
      },
      speakerLoopback: {
        kind: "system-output-loopback",
        device: "BlackHole 2ch",
      },
      browserDevices: {
        microphone: "browser-mic-id",
        speaker: "browser-speaker-id",
      },
      captures: Object.fromEntries(
        [
          ["screen", screenRecording],
          ["microphone", microphoneAudio],
          ["speakerLoopback", speakerLoopbackAudio],
          ["backend", backendLog],
        ].map(([name, file], index) => [
          name,
          {
            startedAt: new Date(Date.now() - 2_000 + index * 50).toISOString(),
            finishedAt: new Date(Date.now() + 2_000).toISOString(),
            sha256: crypto
              .createHash("sha256")
              .update(fs.readFileSync(file))
              .digest("hex"),
            ...(name === "backend"
              ? { source: backendLog, startOffset: 0, endOffset: 32 }
              : {}),
          },
        ]),
      ),
    });
    const fixture = {
      report,
      trajectory,
      backendLog,
      screenRecording,
      microphoneAudio,
      speakerLoopbackAudio,
      captureProvenance,
      microphonePayload,
      ttsPayload,
      referencePayload,
      outDir: path.join(root, "desktop-final"),
      tools,
    };
    const result = finalizeDesktopVoiceEvidence(fixture);
    expect(result.manifest.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "privacy-safe-black-video-plus-projected-loopback-tone",
        }),
        expect.objectContaining({
          role: "privacy-safe-projected-speaker-loopback-duration-tone",
        }),
        expect.objectContaining({
          role: "privacy-safe-correlation-proof",
        }),
      ]),
    );
    expect(result.manifest.proof).toEqual(
      expect.objectContaining({
        modelResponsePresent: true,
        trajectoryMatched: true,
        physicalMicrophoneClassified: true,
        backendEvidencePresent: true,
        publicAudioProjectedFromDurationOnly: true,
        privateAudioPublished: false,
      }),
    );
    const artifactRoles = result.manifest.artifacts.map(({ role }) => role);
    expect(artifactRoles).not.toEqual(
      expect.arrayContaining([
        "packaged-desktop-report",
        "live-llm-trajectory",
        "backend-log",
        "physical-hardware-capture-provenance",
        "physical-microphone",
        "app-synthetic-microphone-signal",
      ]),
    );
    expect(allEvidenceBytes(fixture.outDir).includes(microphoneCanary)).toBe(
      false,
    );
    expect(allEvidenceBytes(fixture.outDir).includes(mediaMetadataCanary)).toBe(
      false,
    );
    const serialized = textualEvidence(fixture.outDir);
    for (const canary of [
      "It is noon.",
      "desktop-trajectory-1",
      "desktop-conversation-1",
      "desktop-user-message-1",
      "[voice] local ASR and TTS complete",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    const projectedFrequencyHz =
      result.manifest.media.acousticProjection.frequencyHz;
    expect(
      spectralMagnitude(decodedAudioSamples(speakerLoopbackAudio, tools), 440),
    ).toBeGreaterThan(0.01);
    for (const artifact of result.manifest.artifacts.filter(
      ({ role }) =>
        role.includes("projected") &&
        (role.includes("tone") || role.includes("video")),
    )) {
      expectOnlyProjectedTone(
        path.join(fixture.outDir, artifact.path),
        tools,
        projectedFrequencyHz,
        [440],
      );
    }
    for (const artifact of result.manifest.artifacts.filter(({ role }) =>
      role.includes("video"),
    )) {
      expectBlackVideo(path.join(fixture.outDir, artifact.path), tools);
    }
    const durationProjectionHashes = result.manifest.artifacts
      .filter(({ role }) => role.endsWith("duration-tone"))
      .map(({ sha256 }) => sha256);
    expect(new Set(durationProjectionHashes).size).toBe(1);
    expectManifestIntegrity(fixture.outDir, result);
    expect(evidenceStagingSiblings(fixture.outDir)).toEqual([]);
    const validReport = fs.readFileSync(report, "utf8");
    const abbreviatedRevision = JSON.parse(validReport);
    abbreviatedRevision.packagedRevision = currentHead().slice(0, 10);
    writeJson(report, abbreviatedRevision);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /running-renderer build stamp for HEAD/,
    );
    fs.writeFileSync(report, validReport);
    const substringBrowserDevice = JSON.parse(validReport);
    substringBrowserDevice.report.stages.find(
      (stage) => stage.stage === "asr",
    ).detail.inputDeviceLabel = "Fake USB test microphone";
    writeJson(report, substringBrowserDevice);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /physical microphone and system-output loopback capture/,
    );
    fs.writeFileSync(report, validReport);
    const punctuationEquivalentDevice = JSON.parse(validReport);
    punctuationEquivalentDevice.report.stages.find(
      (stage) => stage.stage === "asr",
    ).detail.inputDeviceLabel = "microphone, USB TEST";
    writeJson(report, punctuationEquivalentDevice);
    fixture.outDir = path.join(root, "desktop-final-punctuation");
    expect(() => finalizeDesktopVoiceEvidence(fixture)).not.toThrow();
    fs.writeFileSync(report, validReport);
    const genericCollisionDevice = JSON.parse(validReport);
    genericCollisionDevice.report.stages.find(
      (stage) => stage.stage === "asr",
    ).detail.inputDeviceLabel = "USB audio device";
    writeJson(report, genericCollisionDevice);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /physical microphone and system-output loopback capture/,
    );
    fs.writeFileSync(report, validReport);
    const virtualBrowserDevice = JSON.parse(validReport);
    virtualBrowserDevice.report.stages.find(
      (stage) => stage.stage === "asr",
    ).detail.inputDeviceLabel = "BlackHole USB test microphone";
    writeJson(report, virtualBrowserDevice);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /physical microphone and system-output loopback capture/,
    );
    fs.writeFileSync(report, validReport);
    const validProvenance = fs.readFileSync(captureProvenance, "utf8");
    const virtualEndpoint = JSON.parse(validProvenance);
    virtualEndpoint.microphone.enumeratedLabel =
      "BlackHole USB test microphone";
    writeJson(captureProvenance, virtualEndpoint);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /physical microphone and system-output loopback capture/,
    );
    fs.writeFileSync(captureProvenance, validProvenance);
    const wrongDevice = JSON.parse(validProvenance);
    wrongDevice.microphone.enumeratedLabel = "Unrelated webcam microphone";
    writeJson(captureProvenance, wrongDevice);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /physical microphone and system-output loopback capture/,
    );
    fs.writeFileSync(captureProvenance, validProvenance);
    const unboundBackend = JSON.parse(validProvenance);
    unboundBackend.captures.backend.endOffset =
      unboundBackend.captures.backend.startOffset;
    writeJson(captureProvenance, unboundBackend);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /session-bounded log delta/,
    );
    fs.writeFileSync(captureProvenance, validProvenance);
    fs.unlinkSync(speakerLoopbackAudio);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /Missing speaker loopback capture/,
    );
    audio(speakerLoopbackAudio, tools, 440, 3);
    const unsynchronized = JSON.parse(
      fs.readFileSync(captureProvenance, "utf8"),
    );
    unsynchronized.captures.speakerLoopback.sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(speakerLoopbackAudio))
      .digest("hex");
    const unsynchronizedSpeakerStart = new Date(
      Date.parse(unsynchronized.captures.screen.startedAt) + 500,
    ).toISOString();
    unsynchronized.captures.speakerLoopback.startedAt =
      unsynchronizedSpeakerStart;
    const enclosingReport = JSON.parse(validReport);
    enclosingReport.report.startedAt = new Date(
      Date.parse(unsynchronizedSpeakerStart) + 100,
    ).toISOString();
    writeJson(report, enclosingReport);
    writeJson(captureProvenance, unsynchronized);
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /did not start within 250ms/,
    );
    writeJson(captureProvenance, {
      kind: "hosted-virtual-loopback",
      revision: currentHead(),
    });
    expect(() => finalizeDesktopVoiceEvidence(fixture)).toThrow(
      /synchronized, session-bound.*physical microphone and system-output loopback capture/,
    );
  }, 30_000);

  test("refuses wav-direct as packaged real-microphone evidence", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const report = path.join(root, "desktop-report.json");
    writeJson(report, {
      revision: currentHead(),
      sessionId: "voice-session-123456",
      capturedAt: new Date().toISOString(),
      packagedRevision: currentHead(),
      rendererBuildId: "renderer-build-1",
      report: {
        overall: "pass",
        platform: "desktop",
        mode: "wav-direct",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        ttsRoute: "/api/tts/local-inference",
        sendBackend: "local-inference:eliza-1",
        stages: [
          { stage: "asr", status: "pass" },
          {
            stage: "send",
            status: "pass",
            detail: { conversationId: "desktop-conversation-1" },
          },
          { stage: "tts", status: "pass" },
        ],
      },
    });
    expect(() =>
      finalizeDesktopVoiceEvidence({
        report,
        trajectory: report,
        backendLog: report,
        screenRecording: report,
        microphoneAudio: report,
        speakerLoopbackAudio: report,
        captureProvenance: report,
        outDir: path.join(root, "out"),
        tools,
      }),
    ).toThrow(/not a local real-mic pass/);
  });
});

describeWithMedia("hardware audio fingerprint correlation", () => {
  test("accepts bounded latency and noise but rejects unrelated audio", () => {
    const tools = resolveMediaTools();
    const root = fixtureRoot();
    const reference = path.join(root, "reference.wav");
    const shifted = path.join(root, "shifted-noisy.wav");
    const unrelated = path.join(root, "unrelated.wav");
    audio(reference, tools, 440, 2);
    run(tools.ffmpeg, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono:d=0.35",
      "-i",
      reference,
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=2.35:a=0.003",
      "-filter_complex",
      "[0:a][1:a]concat=n=2:v=0:a=1[signal];[signal][2:a]amix=inputs=2:normalize=0[out]",
      "-map",
      "[out]",
      shifted,
    ]);
    audio(unrelated, tools, 930, 2.35);
    expect(
      correlateAudioWindow(
        reference,
        shifted,
        {
          startSeconds: 0,
          durationSeconds: 2.35,
        },
        tools,
      ),
    ).toMatchObject({ correlation: expect.any(Number) });
    expect(() =>
      correlateAudioWindow(
        reference,
        unrelated,
        {
          startSeconds: 0,
          durationSeconds: 2.35,
        },
        tools,
      ),
    ).toThrow(/fingerprint/);
  });
});
