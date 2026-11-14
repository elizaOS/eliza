import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const relative = (file) => fileURLToPath(new URL(file, import.meta.url));
assert.equal(
  path.resolve(process.argv[2] ?? ""),
  relative("./PreparedSpeechPublication.qnt"),
);
const host = readFileSync(
  relative(
    "../native/android/speech-bridge/src/main/java/ai/eliza/voice/LocalSpeechBridgePlugin.java",
  ),
  "utf8",
);
function sourceBetween(startMarker, endMarker) {
  const start = host.indexOf(startMarker);
  const end = host.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing speech source: ${startMarker}`);
  return host.slice(start, end);
}
const predicates = sourceBetween(
  " protected final boolean speakerBusy(",
  " @PluginMethod public void cancel(",
);
const publication = sourceBetween(
  " protected final void publishPreparedAudio(",
  " @PluginMethod public void play(",
);
const fixture = readFileSync(
  relative("./PreparedSpeechPublicationProbe.java.in"),
  "utf8",
);
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const output = mkdtempSync(path.join(tmpdir(), "speech-publication-"));
try {
  const probe = path.join(output, "PreparedSpeechPublicationProbe.java");
  writeFileSync(
    probe,
    fixture
      .replace("// PRODUCTION_PREDICATES", () => predicates)
      .replace("// PRODUCTION_PUBLICATION", () => publication),
  );
  execFileSync(
    java("javac"),
    [
      "--release",
      "17",
      "-J-Xmx128m",
      "-d",
      output,
      relative(
        "../native/android/src/main/java/ai/eliza/voice/SpeechRequestGate.java",
      ),
      probe,
    ],
    { timeout: 60_000 },
  );
  for (const scenario of [
    "late-stream",
    "empty-speaker",
    "existing-clip",
    "cancelled",
    "explicit-replacement",
  ]) {
    const cache = path.join(output, scenario);
    mkdirSync(cache);
    execFileSync(
      java("java"),
      [
        "-Xmx128m",
        "-cp",
        output,
        "PreparedSpeechPublicationProbe",
        scenario,
        cache,
      ],
      { timeout: 15_000 },
    );
    process.stdout.write(`${scenario} passed\n`);
  }
} finally {
  rmSync(output, { recursive: true, force: true });
}
