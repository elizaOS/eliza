import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeWords } from "../voice-quality/wer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const library = path.resolve(
  here,
  "../../../../plugins/plugin-local-inference/native/android",
);
const voice = (root) => path.join(library, root, "java/ai/eliza/voice");
let classes;

before(() => {
  classes = fs.mkdtempSync(path.join(os.tmpdir(), "paradee-plugin-contract-"));
  execFileSync(
    "javac",
    [
      "-d",
      classes,
      path.join(voice("src/main"), "Wer.java"),
      path.join(here, "plugin-contract/PluginContract.java"),
    ],
    { stdio: "pipe" },
  );
});

after(() => fs.rmSync(classes, { recursive: true, force: true }));

test("device Wer normalizes like the host wer.ts", () => {
  const lines = [
    "In 1997 Hurlbut's career — well-known!",
    "one hundred sixty nine targets",
    "nineteen ninety seven",
    "twenty fifteen",
    "three hundred and four indicators",
    "two thousand fifteen",
    "12,000 sentences",
    "one two",
    "oh no",
    "Café & 50% off, nineteen oh five",
    ...fs
      .readFileSync(
        path.join(here, "qualify/app/src/androidTest/assets/sentences.txt"),
        "utf8",
      )
      .split("\n")
      .filter((line) => line.trim()),
  ];
  const java = execFileSync(
    "java",
    ["-cp", classes, "ai.eliza.voice.PluginContract", "wer"],
    { input: `${lines.join("\n")}\n`, encoding: "utf8", timeout: 15000 },
  ).split("\n");
  lines.forEach((line, index) => {
    assert.equal(java[index], normalizeWords(line).join(" "), line);
  });
});

test("the on-device recognizer accepts only plain language tags and defaults to en-US", () => {
  const androidJar = path.join(
    process.env.ANDROID_HOME ?? path.join(os.homedir(), "Android/Sdk"),
    "platforms/android-36/android.jar",
  );
  execFileSync(
    "javac",
    [
      "--release",
      "21",
      "-cp",
      androidJar,
      "-sourcepath",
      path.join(library, "src/main/java"),
      "-d",
      classes,
      path.join(here, "plugin-contract/RecognizerLanguageCheck.java"),
    ],
    { stdio: "pipe" },
  );
  const out = execFileSync(
    "java",
    [
      "-cp",
      `${classes}${path.delimiter}${androidJar}`,
      "ai.eliza.voice.RecognizerLanguageCheck",
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.match(out, /PASS recognizer language tags/);
});
