#!/usr/bin/env bun
/** Build the pinned Phonon-2 GGUF and attribution for ELIZA_VOICE_BUNDLE_FROM. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    out: { type: "string", default: path.join(root, ".cache/phonon-2/bundle") },
    source: {
      type: "string",
      default: path.join(root, ".cache/phonon-2/source"),
    },
    python: { type: "string", default: "python3" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "bun packages/app/scripts/voice/build-phonon2-gguf.ts [--out <bundle>] [--source <download-cache>] [--python <python>]\nPython needs the native submodule gguf-py package, zstandard and librosa. Downloads are pinned and verified. Only the ASR group is built; TTS and VAD are staged separately.",
  );
  process.exit(0);
}

interface Pin {
  size: number;
  sha256: string;
}
const fork = path.join(root, "plugins/plugin-local-inference/native/llama.cpp");
const converter = path.join(fork, "tools/parakeet/convert_phonon2_to_gguf.py");
const pins = JSON.parse(
  await readFile(path.join(fork, "tools/parakeet/pins.json"), "utf8"),
) as {
  model: { repo: string; revision: string };
  files: Record<string, Pin>;
  gguf: Pin & { file: string };
};
const versions = JSON.parse(
  await readFile(
    path.join(
      root,
      "plugins/plugin-native-inference/src/model-catalog/voice-model-versions.json",
    ),
    "utf8",
  ),
) as Array<{
  id: string;
  files?: Array<{ id: string; bytes: number; sha256: string }>;
}>;
const row = versions
  .find((v) => v.id === "mobile-voice")
  ?.files?.find((f) => f.id === "phonon-2-fv5");
if (!row || row.bytes !== pins.gguf.size || row.sha256 !== pins.gguf.sha256) {
  throw new Error(
    "Phonon-2 converter and mobile catalog pins disagree; update the pinned source first.",
  );
}

async function verify(file: string, pin: Pin): Promise<void> {
  if ((await stat(file)).size !== pin.size)
    throw new Error(`Wrong size: ${file}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== pin.sha256)
    throw new Error(`Wrong sha256: ${file}`);
}

const source = path.resolve(values.source);
const destination = path.join(path.resolve(values.out), "asr");
await mkdir(source, { recursive: true });
await mkdir(destination, { recursive: true });
const staging = await mkdtemp(path.join(destination, ".phonon-build-"));
const downloads = await mkdtemp(path.join(source, ".phonon-download-"));
const files = [
  "phonon-2.bps.tar.zst",
  "NOTICE",
  "LICENSE-WEIGHTS-CC-BY-4.0.txt",
] as const;
try {
  for (const name of files) {
    const pin = pins.files[name];
    if (!pin) throw new Error(`Missing source pin: ${name}`);
    const target = path.join(source, name);
    if (!existsSync(target)) {
      const url = `https://huggingface.co/${pins.model.repo}/resolve/${pins.model.revision}/${name}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(600_000),
      });
      if (!response.ok || !response.body)
        throw new Error(`Download ${name}: HTTP ${response.status}`);
      const temporary = path.join(downloads, name);
      await pipeline(
        Readable.from(response.body),
        createWriteStream(temporary, { flags: "wx" }),
      );
      await verify(temporary, pin);
      await rename(temporary, target);
    }
    await verify(target, pin);
  }
  // Require the optional reference dependency so --verify also checks the mel filterbank.
  const dependencies = spawnSync(
    values.python,
    ["-c", "import numpy, zstandard, librosa, yaml, tqdm, requests"],
    { stdio: "inherit" },
  );
  if (dependencies.error) throw dependencies.error;
  if (dependencies.status !== 0)
    throw new Error(
      "Install the native submodule gguf-py package, zstandard and librosa in the selected Python environment.",
    );
  const output = path.join(staging, pins.gguf.file);
  const result = spawnSync(
    values.python,
    [
      converter,
      "--archive",
      path.join(source, files[0]),
      "--notice",
      path.join(source, "NOTICE"),
      "--output",
      output,
      "--verify",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Phonon-2 conversion failed (${result.signal ?? result.status}).`,
    );
  await verify(output, pins.gguf);
  for (const name of files.slice(1))
    await copyFile(path.join(source, name), path.join(destination, name));
  await rename(output, path.join(destination, pins.gguf.file));
  console.log(
    `Verified Phonon-2 and attribution in ${destination}. Use ELIZA_VOICE_BUNDLE_FROM=${path.resolve(values.out)} to stage the ASR group.`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(downloads, { recursive: true, force: true });
}
