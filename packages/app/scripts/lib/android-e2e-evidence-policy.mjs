/**
 * Privacy boundary for physical Android diagnostics. Raw device output remains
 * in the private runner workspace; exported evidence is an allowlisted proof.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const PHASES = new Set([
  "lane-selection",
  "sdk-resolve",
  "device-resolve",
  "device-boot",
  "device-lease",
  "device-prepare",
  "apk-build",
  "apk-install",
  "host-agent-start",
  "host-agent-stop",
  "model-cache",
  "voice-model-stage",
  "local-chat",
  "route-capture",
  "launcher-loop",
  "cloud-provisioning",
  "evidence-projection",
  "runner",
]);

const STATUSES = new Set(["started", "passed", "failed", "skipped"]);
const COUNTERS = new Set(["mediaArtifactCount"]);

const CODES = new Set([
  "PHASE_STARTED",
  "PHASE_PASSED",
  "PHASE_FAILED",
  "DEVICE_READY",
  "DEVICE_LEASED",
  "MODEL_CACHE_READY",
  "MODEL_CACHE_MISSING",
  "MEDIA_RETAINED",
  "EVIDENCE_PROJECTED",
  "ANDROID_E2E_PASSED",
  "ANDROID_E2E_FAILED",
  "UNHANDLED_ERROR",
]);

const STEP_PHASES = new Map([
  ["validate Android lane selection", "lane-selection"],
  ["resolve Android SDK", "sdk-resolve"],
  ["resolve Android device", "device-resolve"],
  ["boot Android device", "device-boot"],
  ["prepare Android device", "device-prepare"],
  ["build Android APK", "apk-build"],
  ["install Android APK", "apk-install"],
  ["start deterministic host agent", "host-agent-start"],
  ["stop deterministic host agent", "host-agent-stop"],
  ["stage Android voice models", "voice-model-stage"],
  ["local chat smoke", "local-chat"],
  ["Android route coverage", "route-capture"],
  ["Android launcher loop", "launcher-loop"],
  ["cloud provisioning", "cloud-provisioning"],
]);

function requireAllowlisted(set, value, label) {
  if (!set.has(value)) {
    throw new Error(`${label} must be allowlisted.`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function exactHexIdentifier(value, length, label) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  ) {
    throw new Error(`${label} must be an exact lowercase hexadecimal value.`);
  }
  return value;
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Returns a logger that never forwards helper text. Callers may report only an
 * allowlisted phase/status/code tuple plus explicitly named numeric counters.
 */
export function createAndroidEvidenceBoundary({
  write = (chunk) => process.stdout.write(chunk),
} = {}) {
  let discardedMessages = 0;
  return {
    callback(phase) {
      requireAllowlisted(PHASES, phase, "Android evidence phase");
      return () => {
        discardedMessages += 1;
      };
    },
    event(phase, status, code, counters = {}) {
      requireAllowlisted(PHASES, phase, "Android evidence phase");
      requireAllowlisted(STATUSES, status, "Android evidence status");
      requireAllowlisted(CODES, code, "Android evidence code");
      const fields = [];
      for (const [name, value] of Object.entries(counters)) {
        if (!COUNTERS.has(name)) {
          throw new Error("Android evidence counter name must be allowlisted.");
        }
        fields.push(`${name}=${safeInteger(value, name)}`);
      }
      write(
        `[android-e2e] phase=${phase} status=${status} code=${code}${fields.length > 0 ? ` ${fields.join(" ")}` : ""}\n`,
      );
    },
    snapshot() {
      return { discardedMessageCount: discardedMessages };
    },
  };
}

/**
 * Runs teardown phases without letting an earlier device failure bypass lease
 * release, evidence projection, or deletion of the private workspace.
 */
export async function settleAndroidEvidenceTeardown({
  operations = [],
  project,
  cleanup,
  onFailure = () => {},
}) {
  let failureCount = 0;
  const recordFailure = (phase) => {
    requireAllowlisted(PHASES, phase, "Android teardown phase");
    failureCount += 1;
    try {
      onFailure(phase);
    } catch {
      // A reporting callback must not bypass the remaining cleanup phases.
    }
  };

  try {
    for (const operation of operations) {
      requireAllowlisted(PHASES, operation.phase, "Android teardown phase");
      try {
        await operation.run();
      } catch {
        recordFailure(operation.phase);
      }
    }
    try {
      await project({ failureCount });
    } catch {
      recordFailure("evidence-projection");
    }
  } finally {
    await cleanup();
  }

  return { failureCount };
}

function projectStep(step) {
  const phase = STEP_PHASES.get(step?.name) ?? "runner";
  const status = step?.status === "passed" ? "passed" : "failed";
  return {
    phase,
    status,
    code: status === "passed" ? "PHASE_PASSED" : "PHASE_FAILED",
  };
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function establishAndroidPublicationTrust(parent) {
  if (process.platform === "win32") {
    // Node does not expose a portable Windows DACL API. Treat the canonical,
    // per-user runner temp directory as the explicit Windows trust boundary;
    // android-e2e chooses a fresh direct child there by default.
    const configuredRoot = process.env.RUNNER_TEMP?.trim() || os.tmpdir();
    const root = fs.realpathSync(configuredRoot);
    const rootStat = fs.lstatSync(root);
    const relative = path.relative(root, parent);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        "Android evidence output must remain inside the canonical runner temp root.",
      );
    }
    return {
      kind: "windows",
      root,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
    };
  }

  const currentUid = process.getuid?.();
  const ancestors = [];
  let current = parent;
  while (true) {
    const stat = fs.lstatSync(current);
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "Android evidence publication ancestry is not canonical.",
      );
    }
    if (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) {
      throw new Error(
        "Android evidence publication ancestry is owned by another principal.",
      );
    }
    if (writableByOthers && !sticky) {
      throw new Error(
        "Android evidence publication ancestry is writable by another principal.",
      );
    }
    ancestors.push({ path: current, dev: stat.dev, ino: stat.ino });
    const container = path.dirname(current);
    if (container === current) break;
    current = container;
  }
  return { kind: "posix", ancestors };
}

function assertAndroidPublicationTrust(parent, trust) {
  if (trust?.kind === "windows") {
    const rootStat = lstatIfPresent(trust.root);
    const relative = path.relative(trust.root, parent);
    if (
      !rootStat ||
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      rootStat.dev !== trust.rootDev ||
      rootStat.ino !== trust.rootIno ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Android evidence runner temp root changed identity.");
    }
    return;
  }
  if (trust?.kind !== "posix" || trust.ancestors?.[0]?.path !== parent) {
    throw new Error("Android evidence publication ancestry trust is missing.");
  }
  const currentUid = process.getuid?.();
  for (const expected of trust.ancestors) {
    const stat = lstatIfPresent(expected.path);
    const writableByOthers = stat ? (stat.mode & 0o022) !== 0 : false;
    const sticky = stat ? (stat.mode & 0o1000) !== 0 : false;
    if (
      !stat ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      (currentUid !== undefined && stat.uid !== currentUid && stat.uid !== 0) ||
      (writableByOthers && !sticky)
    ) {
      throw new Error(
        "Android evidence publication ancestry changed identity or trust.",
      );
    }
  }
}

function prepareOutputPublication(outputDir) {
  if (!outputDir) {
    throw new Error("Android evidence output directory is required.");
  }
  const requestedDestination = path.resolve(outputDir);
  if (requestedDestination === path.parse(requestedDestination).root) {
    throw new Error(
      "Android evidence output directory cannot be a filesystem root.",
    );
  }
  const requestedDestinationStat = lstatIfPresent(requestedDestination);
  if (requestedDestinationStat?.isSymbolicLink()) {
    throw new Error("Android evidence output directory cannot be a symlink.");
  }
  if (requestedDestinationStat) {
    throw new Error(
      "Android evidence output directory must not already exist.",
    );
  }
  const requestedParent = path.dirname(requestedDestination);
  const requestedParentStat = lstatIfPresent(requestedParent);
  let parent;
  if (requestedParentStat) {
    if (
      requestedParentStat.isSymbolicLink() ||
      !requestedParentStat.isDirectory()
    ) {
      throw new Error(
        "Android evidence output parent must be a real directory.",
      );
    }
    parent = fs.realpathSync(requestedParent);
  } else {
    const requestedContainer = path.dirname(requestedParent);
    const requestedContainerStat = lstatIfPresent(requestedContainer);
    if (
      !requestedContainerStat ||
      requestedContainerStat.isSymbolicLink() ||
      !requestedContainerStat.isDirectory()
    ) {
      throw new Error(
        "Android evidence output parent container must already be a real directory.",
      );
    }
    const container = fs.realpathSync(requestedContainer);
    establishAndroidPublicationTrust(container);
    parent = path.join(container, path.basename(requestedParent));
    if (lstatIfPresent(parent)) {
      throw new Error(
        "Android evidence output parent appeared before creation.",
      );
    }
    fs.mkdirSync(parent, { mode: 0o700 });
  }
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Android evidence output parent must be a real directory.");
  }
  const trust = establishAndroidPublicationTrust(parent);
  const destination = path.join(parent, path.basename(requestedDestination));
  if (lstatIfPresent(destination)) {
    throw new Error(
      "Android evidence output directory must not already exist.",
    );
  }
  const stagingPrefix = `.${path.basename(destination)}.android-evidence-staging-`;
  const staging = fs.mkdtempSync(path.join(parent, stagingPrefix));
  fs.chmodSync(staging, 0o700);
  const stagingStat = fs.lstatSync(staging);
  const publication = {
    destination,
    parent,
    parentStat,
    staging,
    stagingPrefix,
    stagingStat,
    trust,
  };
  assertPublicationParentIdentity(publication);
  assertStagingIdentity(publication);
  return publication;
}

function assertPublicationParentIdentity(publication) {
  const {
    destination,
    parent,
    parentStat: expectedParentStat,
    staging,
  } = publication;
  if (
    path.dirname(destination) !== parent ||
    path.dirname(staging) !== parent
  ) {
    throw new Error(
      "Android evidence publication paths escaped their owned parent.",
    );
  }
  const parentStat = lstatIfPresent(parent);
  if (
    !parentStat ||
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    parentStat.dev !== expectedParentStat.dev ||
    parentStat.ino !== expectedParentStat.ino
  ) {
    throw new Error("Android evidence publication parent changed identity.");
  }
  assertAndroidPublicationTrust(parent, publication.trust);
}

function assertStagingIdentity(publication, { allowMissing = false } = {}) {
  const {
    parent,
    staging,
    stagingPrefix,
    stagingStat: expectedStagingStat,
  } = publication;
  assertPublicationParentIdentity(publication);
  if (
    path.dirname(staging) !== parent ||
    !path.basename(staging).startsWith(stagingPrefix)
  ) {
    throw new Error("Refusing to clean an unowned Android staging path.");
  }
  const stagingStat = lstatIfPresent(staging);
  if (!stagingStat) {
    if (allowMissing) return undefined;
    throw new Error("Android evidence staging directory disappeared.");
  }
  if (
    stagingStat.isSymbolicLink() ||
    !stagingStat.isDirectory() ||
    stagingStat.dev !== expectedStagingStat.dev ||
    stagingStat.ino !== expectedStagingStat.ino
  ) {
    throw new Error("Android evidence staging directory changed identity.");
  }
  return stagingStat;
}

function removeOwnedStagingDirectory(publication) {
  if (!assertStagingIdentity(publication, { allowMissing: true })) return;
  const tombstone = `${publication.staging}.cleanup`;
  if (lstatIfPresent(tombstone)) {
    throw new Error("Android evidence cleanup tombstone already exists.");
  }
  fs.renameSync(publication.staging, tombstone);
  const tombstoneStat = fs.lstatSync(tombstone);
  if (
    tombstoneStat.isSymbolicLink() ||
    !tombstoneStat.isDirectory() ||
    tombstoneStat.dev !== publication.stagingStat.dev ||
    tombstoneStat.ino !== publication.stagingStat.ino
  ) {
    throw new Error("Android evidence cleanup tombstone changed identity.");
  }
  fs.rmSync(tombstone, { recursive: true, force: true, maxRetries: 2 });
}

function publicationChildPath(root, file, label) {
  const relative = path.relative(root, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the Android staging directory.`);
  }
  return relative;
}

function verifyStagedAndroidEvidence(publication, result) {
  assertStagingIdentity(publication);
  const { staging } = publication;
  const summaryRelative = publicationChildPath(
    staging,
    result.summaryPath,
    "Android evidence summary",
  );
  const junitRelative = publicationChildPath(
    staging,
    result.junitPath,
    "Android evidence JUnit report",
  );
  if (summaryRelative !== "summary.json" || junitRelative !== "junit.xml") {
    throw new Error("Android evidence report paths are not canonical.");
  }
  const summaryStat = fs.lstatSync(result.summaryPath);
  const junitStat = fs.lstatSync(result.junitPath);
  if (
    summaryStat.isSymbolicLink() ||
    !summaryStat.isFile() ||
    junitStat.isSymbolicLink() ||
    !junitStat.isFile()
  ) {
    throw new Error("Android evidence reports must be regular files.");
  }
  const persistedSummary = JSON.parse(fs.readFileSync(result.summaryPath));
  if (
    JSON.stringify(persistedSummary) !== JSON.stringify(result.summary) ||
    persistedSummary.schema !== "eliza_android_private_input_projection_v1" ||
    persistedSummary.lane !== "android" ||
    !Array.isArray(persistedSummary.media)
  ) {
    throw new Error("Android evidence summary is incomplete or divergent.");
  }
  if (fs.readFileSync(result.junitPath, "utf8") !== result.junit) {
    throw new Error("Android evidence JUnit report changed after staging.");
  }

  const mediaDir = path.join(staging, "media");
  const mediaDirStat = fs.lstatSync(mediaDir);
  if (mediaDirStat.isSymbolicLink() || !mediaDirStat.isDirectory()) {
    throw new Error("Android evidence media path must be a real directory.");
  }
  const expectedMedia = new Set();
  for (const media of persistedSummary.media) {
    if (media.path !== "media/android-route-coverage.mp4") {
      throw new Error("Android evidence media path is not allowlisted.");
    }
    const file = path.join(staging, media.path);
    publicationChildPath(staging, file, "Android evidence media");
    const fileStat = fs.lstatSync(file);
    if (
      fileStat.isSymbolicLink() ||
      !fileStat.isFile() ||
      fileStat.size !== media.byteCount ||
      sha256File(file) !== media.sha256
    ) {
      throw new Error("Android evidence media hash verification failed.");
    }
    if (expectedMedia.has(path.basename(media.path))) {
      throw new Error("Android evidence media contains a duplicate path.");
    }
    expectedMedia.add(path.basename(media.path));
  }
  const mediaEntries = fs.readdirSync(mediaDir, { withFileTypes: true });
  if (
    mediaEntries.length !== expectedMedia.size ||
    mediaEntries.some((entry) => {
      const fileStat = fs.lstatSync(path.join(mediaDir, entry.name));
      return (
        entry.isSymbolicLink() ||
        !fileStat.isFile() ||
        !expectedMedia.has(entry.name)
      );
    })
  ) {
    throw new Error("Android evidence media contains unmanifested files.");
  }
  const rootEntries = fs.readdirSync(staging, { withFileTypes: true });
  const expectedRootEntries = new Set(["junit.xml", "media", "summary.json"]);
  if (
    rootEntries.length !== expectedRootEntries.size ||
    rootEntries.some((entry) => {
      const entryStat = fs.lstatSync(path.join(staging, entry.name));
      if (!expectedRootEntries.has(entry.name) || entryStat.isSymbolicLink()) {
        return true;
      }
      return entry.name === "media"
        ? !entryStat.isDirectory()
        : !entryStat.isFile();
    })
  ) {
    throw new Error("Android evidence staging contains unmanifested entries.");
  }
}

function publishStagedAndroidEvidence(publication, result) {
  verifyStagedAndroidEvidence(publication, result);
  assertStagingIdentity(publication);
  const publishedResult = {
    summary: result.summary,
    summaryPath: path.join(
      publication.destination,
      publicationChildPath(
        publication.staging,
        result.summaryPath,
        "Android evidence summary",
      ),
    ),
    junitPath: path.join(
      publication.destination,
      publicationChildPath(
        publication.staging,
        result.junitPath,
        "Android evidence JUnit report",
      ),
    ),
  };
  if (lstatIfPresent(publication.destination)) {
    throw new Error(
      "Android evidence output path appeared before atomic publication.",
    );
  }
  assertPublicationParentIdentity(publication);
  assertStagingIdentity(publication);
  fs.renameSync(publication.staging, publication.destination);
  return publishedResult;
}

function atomicallyPublishAndroidEvidence(outputDir, build) {
  const publication = prepareOutputPublication(outputDir);
  let published = false;
  try {
    const result = build(publication.staging);
    const publishedResult = publishStagedAndroidEvidence(publication, result);
    published = true;
    return publishedResult;
  } finally {
    if (!published) removeOwnedStagingDirectory(publication);
  }
}

function privateRegularFile(bundleRoot, artifactPath) {
  const root = `${path.resolve(bundleRoot)}${path.sep}`;
  const candidate = path.resolve(artifactPath);
  if (!candidate.startsWith(root)) return false;
  try {
    return fs.lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

function packagedFfmpeg() {
  try {
    const loaded = require("ffmpeg-static");
    return typeof loaded === "string" ? loaded : loaded?.path;
  } catch {
    return undefined;
  }
}

function defaultRedactVideo(source, destination) {
  const candidates = [
    process.env.ELIZA_FFMPEG_BIN,
    packagedFfmpeg(),
    "ffmpeg",
  ].filter(Boolean);
  for (const command of candidates) {
    const result = spawnSync(
      command,
      [
        "-y",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-movflags",
        "+faststart",
        destination,
      ],
      { stdio: "ignore" },
    );
    if (
      result.status === 0 &&
      fs.existsSync(destination) &&
      fs.statSync(destination).size > 0
    ) {
      return;
    }
    fs.rmSync(destination, { force: true });
  }
  throw new Error("Android evidence video redaction failed.");
}

/**
 * Projects a private Android run into upload-safe evidence. Correlation and
 * failure details stay in memory; only the synthetic route video and safe
 * phase/counter proof cross this boundary.
 */
export function projectAndroidDeviceEvidenceBundle({
  bundle,
  outputDir,
  result,
  redactVideo = defaultRedactVideo,
}) {
  if (!bundle?.root || bundle.lane !== "android") {
    throw new Error("A private Android evidence bundle is required.");
  }
  requireAllowlisted(new Set(["passed", "failed"]), result, "Android result");
  const revision = exactHexIdentifier(
    bundle.build?.commit,
    40,
    "Android evidence revision",
  );
  const rendererBuildId = exactHexIdentifier(
    bundle.build?.buildId,
    64,
    "Android renderer build ID",
  );
  const phases = (bundle.steps ?? []).map(projectStep);
  const canonicalRouteVideo = path.resolve(
    bundle.root,
    "raw",
    "android-route-coverage.mp4",
  );
  const routeMedia = (bundle.artifacts ?? []).filter(
    (artifact) =>
      artifact?.kind === "video" &&
      path.resolve(artifact.path ?? "") === canonicalRouteVideo &&
      privateRegularFile(bundle.root, artifact.path),
  );
  const passedRouteCapture = phases.some(
    (phase) => phase.phase === "route-capture" && phase.status === "passed",
  );
  if (passedRouteCapture && routeMedia.length !== 1) {
    throw new Error(
      "Passed Android route capture requires exactly one private video.",
    );
  }
  return atomicallyPublishAndroidEvidence(outputDir, (stagingDir) => {
    fs.mkdirSync(path.join(stagingDir, "media"), { mode: 0o700 });
    const retainedMedia = [];

    for (const artifact of routeMedia) {
      const destination = path.join(
        stagingDir,
        "media",
        "android-route-coverage.mp4",
      );
      redactVideo(artifact.path, destination);
      const projectedStat = fs.lstatSync(destination);
      if (projectedStat.isSymbolicLink() || !projectedStat.isFile()) {
        throw new Error(
          "Android evidence video projection must create a regular file.",
        );
      }
      retainedMedia.push({
        role: "synthetic-route-signal",
        path: "media/android-route-coverage.mp4",
        byteCount: projectedStat.size,
        sha256: sha256File(destination),
      });
      break;
    }

    const counts = {
      passed: phases.filter((phase) => phase.status === "passed").length,
      failed: phases.filter((phase) => phase.status === "failed").length,
      mediaArtifacts: retainedMedia.length,
    };
    const summary = {
      schema: "eliza_android_private_input_projection_v1",
      lane: "android",
      result,
      revision,
      rendererBuildId,
      device: { kind: "android", attached: true },
      counts,
      phases,
      media: retainedMedia,
    };
    const summaryPath = path.join(stagingDir, "summary.json");
    writeJson(summaryPath, summary);

    const cases =
      phases.length > 0
        ? phases
            .map((phase) => {
              const failure =
                phase.status === "failed"
                  ? `<failure message="${phase.code}" />`
                  : "";
              return `<testcase classname="android" name="${xmlEscape(phase.phase)}">${failure}</testcase>`;
            })
            .join("\n")
        : '<testcase classname="android" name="runner" />';
    const junitPath = path.join(stagingDir, "junit.xml");
    const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="android" tests="${phases.length || 1}" failures="${counts.failed}" result="${result}">\n${cases}\n</testsuite>\n`;
    fs.writeFileSync(junitPath, junit);

    return { summary, summaryPath, junitPath, junit };
  });
}
