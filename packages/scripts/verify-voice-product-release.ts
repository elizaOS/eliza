/**
 * Release gate for the product voice stack: Phonon-2 ASR and Paradee-8M v1.1
 * TTS on libelizainference (the elizaOS llama.cpp fork). There is no other
 * product ASR or TTS model.
 *
 * The gate reads the newest `mobile-voice` entry of the voice catalog and
 * requires its Phonon-2 (`asr-parakeet`) and Paradee (`tts`) rows to:
 *   - pin the converted GGUF by sha256 and byte size, equal to
 *     `plugins/plugin-local-inference/native/android/inputs.json`;
 *   - name the Hugging Face source repository inputs.json pins
 *     (FermionResearch/Phonon-2, sahilmahendrakar/Paradee-8M-v1.1) at an
 *     immutable 40-character revision;
 *   - pin every source file by sha256 and byte size, including the model
 *     weights the converter reads;
 *   - agree with the fork's `tools/parakeet/pins.json` and
 *     `tools/paradee/pins.json` when the llama.cpp submodule is checked out
 *     (`--require-fork-pins` makes a missing checkout an error).
 *
 * Unless `--offline` is passed it then resolves every source file on Hugging
 * Face at the pinned revision without downloading weights: the resolver must
 * report that commit, and the LFS sha256 and size it reports must match the
 * pins. Small files Hugging Face stores in git are fetched and hashed.
 *
 * The GGUFs are built from these sources by the byte-reproducible converters;
 * they are not uploaded to elizaos/eliza-1, and the gate does not ask for that.
 *
 *   node packages/scripts/verify-voice-product-release.ts [--offline]
 *     [--require-fork-pins] [--github-annotations]
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CATALOG_PATH = path.join(
  repoRoot,
  "plugins/plugin-native-inference/src/model-catalog/voice-model-versions.json",
);
const INPUTS_PATH = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/android/inputs.json",
);
const FORK_PATH = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/llama.cpp",
);

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const HF_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface SourceFile {
  path: string;
  sha256: string;
  bytes?: number;
}

interface CatalogFile {
  id: string;
  role: string;
  path: string;
  sha256: string | null;
  bytes: number | null;
  source?: { repo: string; revision: string; files?: SourceFile[] };
}

interface CatalogVersion {
  id: string;
  version: string;
  files?: CatalogFile[];
}

interface Pin {
  path: string;
  bytes: number;
  sha256: string;
  source: string;
  version?: string;
}

interface ForkPins {
  model: { repo: string; revision: string };
  files: Record<string, { size: number; sha256: string }>;
  /** Phonon-2 pins the GGUF here; Paradee under `gguf.f32`. */
  gguf?: {
    size?: number;
    sha256?: string;
    f32?: { size: number; sha256: string };
  };
}

/** One product component the gate checks. */
interface Component {
  name: string;
  role: string;
  /** Key of the pin in inputs.json. */
  input: "asr" | "paradee";
  /** Files the converter reads; each must be pinned in the row's source. */
  requiredSources: string[];
  /** The fork pins for this component, when the submodule is checked out. */
  forkPins: (fork: string) => ForkPins | null;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function forkJson<T>(fork: string, rel: string): T | null {
  const file = path.join(fork, rel);
  return existsSync(file) ? readJson<T>(file) : null;
}

export const COMPONENTS: readonly Component[] = [
  {
    name: "Phonon-2 ASR",
    role: "asr-parakeet",
    input: "asr",
    requiredSources: ["phonon-2.bps.tar.zst"],
    forkPins: (fork) => forkJson<ForkPins>(fork, "tools/parakeet/pins.json"),
  },
  {
    name: "Paradee-8M v1.1 TTS",
    role: "tts",
    input: "paradee",
    requiredSources: [
      "pytorch/text_side.pt",
      "pytorch/decoder.pt",
      "config.json",
      "tokenizer.json",
    ],
    forkPins: (fork) =>
      forkJson<Record<string, ForkPins>>(fork, "tools/paradee/pins.json")?.[
        "v1.1"
      ] ?? null,
  },
];

/** Newest `mobile-voice` catalog entry (the file lists it first). */
export function latestMobileVoice(
  versions: readonly CatalogVersion[],
): CatalogVersion | undefined {
  return versions.find((version) => version.id === "mobile-voice");
}

/** Hugging Face repo named in an inputs.json `source` sentence. */
function inputsRepo(pin: Pin, candidates: readonly string[]): string | null {
  return candidates.find((repo) => pin.source.includes(repo)) ?? null;
}

export interface ReleaseCheck {
  version?: string;
  rows: Array<{ component: Component; row: CatalogFile }>;
  errors: string[];
  forkPinsChecked: boolean;
}

/** Offline checks: catalog row shape, inputs.json and fork pins. */
export function validateProductVoiceRelease({
  versions = readJson<CatalogVersion[]>(CATALOG_PATH),
  inputs = readJson<Record<string, Pin>>(INPUTS_PATH),
  fork = FORK_PATH,
  requireForkPins = false,
}: {
  versions?: readonly CatalogVersion[];
  inputs?: Record<string, Pin>;
  fork?: string;
  requireForkPins?: boolean;
} = {}): ReleaseCheck {
  const errors: string[] = [];
  const rows: ReleaseCheck["rows"] = [];
  let forkPinsChecked = false;
  const release = latestMobileVoice(versions);
  if (!release?.files?.length) {
    return {
      rows,
      errors: ["The voice catalog declares no mobile-voice entry with files."],
      forkPinsChecked,
    };
  }
  const label = `mobile-voice ${release.version}`;

  const asrRoles = release.files.filter((file) => file.role.startsWith("asr"));
  for (const file of asrRoles) {
    if (file.role !== "asr-parakeet") {
      errors.push(
        `${label} lists ${file.id} (${file.role}); Phonon-2 is the only product ASR.`,
      );
    }
  }
  for (const file of release.files) {
    if (/gemma|qwen|eliza-1-asr|kokoro/i.test(`${file.id} ${file.path}`)) {
      errors.push(`${label} lists retired voice model ${file.id}.`);
    }
  }

  for (const component of COMPONENTS) {
    const matching = release.files.filter(
      (file) => file.role === component.role,
    );
    if (matching.length !== 1) {
      errors.push(
        `${label} must list exactly one ${component.role} row for ${component.name} (found ${matching.length}).`,
      );
      continue;
    }
    const row = matching[0];
    rows.push({ component, row });
    const pin = inputs[component.input];
    if (!pin) {
      errors.push(`inputs.json has no ${component.input} pin.`);
      continue;
    }
    if (row.path !== pin.path) {
      errors.push(
        `${row.id} path ${row.path} differs from inputs.json ${pin.path}.`,
      );
    }
    if (!row.sha256 || !SHA256.test(row.sha256) || row.sha256 !== pin.sha256) {
      errors.push(
        `${row.id} sha256 ${JSON.stringify(row.sha256)} must equal inputs.json ${pin.sha256}.`,
      );
    }
    if (
      !Number.isSafeInteger(row.bytes) ||
      (row.bytes ?? 0) <= 0 ||
      row.bytes !== pin.bytes
    ) {
      errors.push(
        `${row.id} size ${JSON.stringify(row.bytes)} must equal inputs.json ${pin.bytes}.`,
      );
    }

    const source = row.source;
    if (!source) {
      errors.push(`${row.id} has no Hugging Face source pin.`);
      continue;
    }
    if (!HF_REPO.test(source.repo)) {
      errors.push(
        `${row.id} source ${JSON.stringify(source.repo)} is not a Hugging Face repository.`,
      );
    }
    if (inputsRepo(pin, [source.repo]) === null) {
      errors.push(
        `${row.id} source ${source.repo} is not the repository inputs.json pins (${pin.source}).`,
      );
    }
    if (!REVISION.test(source.revision ?? "")) {
      errors.push(
        `${row.id} source has no immutable 40-character Hugging Face revision (found ${JSON.stringify(source.revision)}).`,
      );
    }
    const files = source.files ?? [];
    for (const file of files) {
      if (!SHA256.test(file.sha256)) {
        errors.push(`${row.id} source ${file.path} has no valid sha256 pin.`);
      }
      if (!Number.isSafeInteger(file.bytes) || (file.bytes ?? 0) <= 0) {
        errors.push(`${row.id} source ${file.path} has no positive size pin.`);
      }
    }
    for (const required of component.requiredSources) {
      if (!files.some((file) => file.path === required)) {
        errors.push(`${row.id} source does not pin ${required}.`);
      }
    }

    const forkPins = component.forkPins(fork);
    if (!forkPins) {
      if (requireForkPins) {
        errors.push(
          `${component.name}: the llama.cpp fork pins are not checked out at ${path.relative(repoRoot, fork)}.`,
        );
      }
      continue;
    }
    forkPinsChecked = true;
    if (
      forkPins.model.repo !== source.repo ||
      forkPins.model.revision !== source.revision
    ) {
      errors.push(
        `${row.id} source ${source.repo}@${source.revision} differs from the fork pin ${forkPins.model.repo}@${forkPins.model.revision}.`,
      );
    }
    const forkGguf = forkPins.gguf?.f32 ?? forkPins.gguf;
    if (forkGguf?.sha256 !== row.sha256 || forkGguf?.size !== row.bytes) {
      errors.push(
        `${row.id} GGUF pin ${row.bytes} ${row.sha256} differs from the fork's converter output pin ${forkGguf?.size} ${forkGguf?.sha256}.`,
      );
    }
    for (const file of files) {
      const forkFile = forkPins.files[file.path];
      if (
        !forkFile ||
        forkFile.sha256 !== file.sha256 ||
        forkFile.size !== file.bytes
      ) {
        errors.push(
          `${row.id} source ${file.path} differs from the fork pin (${forkFile ? `${forkFile.size} ${forkFile.sha256}` : "missing"}).`,
        );
      }
    }
  }
  return { version: release.version, rows, errors, forkPinsChecked };
}

function unquote(value: string | null): string | null {
  return value?.trim().replace(/^W\//, "").replace(/^"|"$/g, "") ?? null;
}

type FetchFn = typeof fetch;

/**
 * Resolve one source file at its pinned revision. LFS files are checked from
 * the resolver headers alone; files stored in git are downloaded (they are
 * small) and hashed.
 */
async function verifyRemoteFile(
  repo: string,
  revision: string,
  file: SourceFile,
  fetchFn: FetchFn,
  timeoutMs: number,
): Promise<string[]> {
  const url = `https://huggingface.co/${repo}/resolve/${revision}/${file.path}`;
  const where = `${repo}@${revision.slice(0, 12)} ${file.path}`;
  let head: Response;
  try {
    head = await fetchFn(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return [
      `${where} could not be resolved: ${error instanceof Error ? error.message : String(error)}.`,
    ];
  }
  if (head.status < 200 || head.status >= 400) {
    return [`${where} is not downloadable (HTTP ${head.status}).`];
  }
  const errors: string[] = [];
  const commit = head.headers.get("x-repo-commit");
  if (commit !== revision) {
    errors.push(
      `${where} resolved from commit ${JSON.stringify(commit)}, expected ${revision}.`,
    );
  }
  const linked = unquote(head.headers.get("x-linked-etag"));
  if (linked && SHA256.test(linked)) {
    if (linked !== file.sha256) {
      errors.push(
        `${where} resolver sha256 ${linked} does not match the pin ${file.sha256}.`,
      );
    }
    const size = Number(head.headers.get("x-linked-size"));
    if (size !== file.bytes) {
      errors.push(
        `${where} resolver size ${head.headers.get("x-linked-size")} does not match the pin ${file.bytes}.`,
      );
    }
    return errors;
  }
  // Stored in git, not LFS: the etag is a git blob id, so hash the bytes.
  let body: Buffer;
  try {
    const response = await fetchFn(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return [...errors, `${where} download failed (HTTP ${response.status}).`];
    }
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return [
      ...errors,
      `${where} download failed: ${error instanceof Error ? error.message : String(error)}.`,
    ];
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== file.sha256 || body.length !== file.bytes) {
    errors.push(
      `${where} is ${body.length} bytes sha256 ${digest}; the pin is ${file.bytes} ${file.sha256}.`,
    );
  }
  return errors;
}

/** Offline checks, then every source file against Hugging Face. */
export async function verifyProductVoiceRelease({
  offline = false,
  requireForkPins = false,
  fetchFn = fetch,
  timeoutMs = 30_000,
}: {
  offline?: boolean;
  requireForkPins?: boolean;
  fetchFn?: FetchFn;
  timeoutMs?: number;
} = {}): Promise<ReleaseCheck & { remoteFiles: number }> {
  const result = validateProductVoiceRelease({ requireForkPins });
  if (offline || result.errors.length > 0) {
    return { ...result, remoteFiles: 0 };
  }
  const errors = [...result.errors];
  let remoteFiles = 0;
  for (const { row } of result.rows) {
    const source = row.source;
    if (!source) continue;
    for (const file of source.files ?? []) {
      remoteFiles += 1;
      errors.push(
        ...(await verifyRemoteFile(
          source.repo,
          source.revision,
          file,
          fetchFn,
          timeoutMs,
        )),
      );
    }
  }
  return { ...result, errors, remoteFiles };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const githubAnnotations = argv.includes("--github-annotations");
  const result = await verifyProductVoiceRelease({
    offline: argv.includes("--offline"),
    requireForkPins: argv.includes("--require-fork-pins"),
  });
  if (result.errors.length > 0) {
    for (const message of result.errors) {
      if (githubAnnotations) {
        console.error(`::error title=Product voice release::${message}`);
      } else {
        console.error(`[voice-product-release] ${message}`);
      }
    }
    return 1;
  }
  const summary = result.rows
    .map(
      ({ row }) =>
        `${row.id} (${row.source?.repo}@${row.source?.revision}, ${row.source?.files?.length ?? 0} source files)`,
    )
    .join("; ");
  console.log(
    `[voice-product-release] mobile-voice ${result.version}: ${summary}; fork pins ${result.forkPinsChecked ? "checked" : "not checked out"}; ${result.remoteFiles > 0 ? `${result.remoteFiles} source files verified on Hugging Face` : "offline"}.`,
  );
  return 0;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = await main();
}
