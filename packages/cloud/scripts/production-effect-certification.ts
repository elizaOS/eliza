/** Admits production effects after exact-source main validation and tree-bound staging certification. */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalJson,
  currentValidationManifest,
  verifyCompleteManifest,
} from "../../scripts/develop-impact-evidence.ts";
import { execFileSync } from "../../scripts/lib/spawn-sync-captured.ts";
import {
  artifactNameForTree,
  CERTIFICATION_FILENAME,
  CERTIFICATION_WORKFLOW,
  verifyStagingReleaseCertification,
} from "./staging-release-certification.ts";

/** Checks the downloaded archive before reading its one canonical JSON member without extracting any paths. */
export function readCertificationArchive(bytes, expectedDigest) {
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== expectedDigest)
    throw new Error("Production certification archive digest mismatch");
  const directory = mkdtempSync(
    path.join(tmpdir(), "eliza-staging-certification-"),
  );
  try {
    const archive = path.join(directory, "certificate.zip");
    writeFileSync(archive, bytes, { mode: 0o600 });
    const text = execFileSync(
      "unzip",
      ["-p", archive, CERTIFICATION_FILENAME],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    return JSON.parse(text);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const MAIN_VALIDATION_WORKFLOW = ".github/workflows/develop-full.yml";

/** Reads exactly the three existing Full manifest members, never extracting paths. */
export function readValidationArchive(bytes, expectedDigest) {
  if (
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !==
    expectedDigest
  )
    throw new Error("Main validation archive digest mismatch");
  const directory = mkdtempSync(path.join(tmpdir(), "eliza-main-validation-"));
  try {
    const archive = path.join(directory, "manifest.zip");
    writeFileSync(archive, bytes, { mode: 0o600 });
    const options = {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    };
    const members = execFileSync("unzip", ["-Z1", archive], options)
      .trim()
      .split("\n");
    if (
      canonicalJson(members.sort()) !==
      canonicalJson(["expected.json", "observed.json", "results.json"])
    )
      throw new Error("Main validation archive has ambiguous members");
    return Object.fromEntries(
      members.map((member) => [
        member.slice(0, -5),
        JSON.parse(execFileSync("unzip", ["-p", archive, member], options)),
      ]),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validationInputs(manifest) {
  const {
    baseSha: _base,
    changedPaths: _changed,
    unknownPaths: _unknown,
    ...inputs
  } = manifest;
  return {
    ...inputs,
    surfaces: manifest.surfaces.map(
      ({ forceRun: _force, invalidated: _invalidated, ...surface }) => surface,
    ),
  };
}

function assertMainRun(run, repository, sourceSha) {
  if (
    run.repository?.full_name !== repository ||
    run.path !== MAIN_VALIDATION_WORKFLOW ||
    run.head_sha !== sourceSha ||
    run.head_branch !== "main" ||
    !["push", "workflow_dispatch"].includes(run.event) ||
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error(
      "Production requires successful exact-source main Full validation",
    );
}

/** Uses the existing complete manifest, including every current source-bound surface. */
export function verifyMainValidation({
  run,
  artifact,
  archive,
  repository,
  sourceSha,
  expected,
  now = new Date(),
}) {
  assertMainRun(run, repository, sourceSha);
  if (
    artifact.name !== `develop-full-manifest-${sourceSha}` ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run?.head_sha !== sourceSha ||
    artifact.workflow_run?.head_branch !== "main" ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")
  )
    throw new Error("Main validation artifact identity mismatch");
  const { expected: recorded, observed, results } = archive;
  if (
    expected.headSha !== sourceSha ||
    canonicalJson(validationInputs(recorded)) !==
      canonicalJson(validationInputs(expected))
  )
    throw new Error("Main validation inputs differ from current source");
  const ids = expected.surfaces.map((surface) => surface.id).sort();
  if (
    !["canonical", "cloud", "ui-core"].every((id) => ids.includes(id)) ||
    canonicalJson(Object.keys(results.results ?? {}).sort()) !==
      canonicalJson(ids) ||
    !ids.every((id) => results.results[id] === "success") ||
    results.headSha !== sourceSha ||
    String(results.runId) !== String(run.id) ||
    String(results.runAttempt) !== String(run.run_attempt)
  )
    throw new Error(
      "Main validation results are incomplete or from another attempt",
    );
  if (
    !Array.isArray(observed.surfaces) ||
    !observed.surfaces.every((row) => row.sourceSha === sourceSha)
  )
    throw new Error("Main validation rows must belong to the exact source");
  const verified = verifyCompleteManifest(expected, observed.surfaces, now);
  if (canonicalJson(verified) !== canonicalJson(observed))
    throw new Error("Main validation manifest identity mismatch");
  return {
    runId: run.id,
    runAttempt: run.run_attempt,
    sourceSha,
    expiresAt: new Date(
      Math.min(...verified.surfaces.map((row) => Date.parse(row.expiresAt))),
    ).toISOString(),
  };
}

/** A rerun or a newer failed/running source run cannot borrow an older successful artifact. */
export async function requireMainValidation({
  api,
  repository,
  sourceSha,
  repoRoot,
  now,
}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? ""))
    throw new Error("Main validation requires an exact source SHA");
  const endpoint = `/actions/workflows/develop-full.yml/runs?branch=main&head_sha=${sourceSha}&per_page=100`;
  const latest = async () => {
    const response = await api.request("GET", endpoint);
    if (
      !Array.isArray(response?.workflow_runs) ||
      response.workflow_runs.length === 0 ||
      response.workflow_runs.length >= 100 ||
      response.total_count !== response.workflow_runs.length
    )
      throw new Error("Main validation run inventory is missing or ambiguous");
    return [...response.workflow_runs].sort((a, b) => b.id - a.id)[0];
  };
  const run = await latest();
  assertMainRun(run, repository, sourceSha);
  const response = await api.request(
    "GET",
    `/actions/runs/${run.id}/artifacts?per_page=100`,
  );
  if (
    !Array.isArray(response?.artifacts) ||
    response.artifacts.length >= 100 ||
    response.total_count !== response.artifacts.length
  )
    throw new Error(
      "Main validation artifact inventory is missing or ambiguous",
    );
  const artifacts = response.artifacts.filter(
    (artifact) => artifact.name === `develop-full-manifest-${sourceSha}`,
  );
  if (artifacts.length !== 1)
    throw new Error("Main validation requires one current manifest artifact");
  const artifact = artifacts[0];
  const bytes = await api.request(
    "GET",
    `/actions/artifacts/${artifact.id}/zip`,
    undefined,
    "bytes",
  );
  const proof = verifyMainValidation({
    run,
    artifact,
    archive: readValidationArchive(bytes, artifact.digest),
    repository,
    sourceSha,
    expected: currentValidationManifest(repoRoot, sourceSha),
    ...(now === undefined ? {} : { now }),
  });
  const current = await api.request("GET", `/actions/runs/${run.id}`);
  assertMainRun(current, repository, sourceSha);
  const newest = await latest();
  assertMainRun(newest, repository, sourceSha);
  if (
    current.run_attempt !== run.run_attempt ||
    newest.id !== run.id ||
    newest.run_attempt !== run.run_attempt
  )
    throw new Error("Main validation changed during production admission");
  return proof;
}

/** Resolves only successful staging-run artifacts; a receipt or an artifact name alone cannot authorize dispatch. */
export async function requireProductionCertification({
  api,
  repository,
  treeSha,
  sourceSha,
  repoRoot,
  now,
}) {
  const mainValidation = await requireMainValidation({
    api,
    repository,
    sourceSha,
    repoRoot,
    now,
  });
  const name = artifactNameForTree(treeSha);
  const response = await api.request(
    "GET",
    `/actions/artifacts?name=${name}&per_page=100`,
  );
  if (!Array.isArray(response?.artifacts) || response.artifacts.length >= 100)
    throw new Error(
      "Production certification artifact inventory is missing or ambiguous",
    );
  const artifacts = response.artifacts
    .filter(
      (artifact) =>
        artifact.name === name &&
        artifact.expired === false &&
        /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") &&
        Number.isSafeInteger(artifact.id) &&
        artifact.id > 0 &&
        Number.isSafeInteger(artifact.workflow_run?.id) &&
        artifact.workflow_run.id > 0,
    )
    .sort((left, right) => right.id - left.id);
  const workflowSha256 = createHash("sha256")
    .update(readFileSync(path.join(repoRoot, CERTIFICATION_WORKFLOW)))
    .digest("hex");
  for (const artifact of artifacts) {
    const run = await api.request(
      "GET",
      `/actions/runs/${artifact.workflow_run.id}`,
    );
    if (
      run.status !== "completed" ||
      run.conclusion !== "success" ||
      run.head_branch !== "staging" ||
      run.path !== CERTIFICATION_WORKFLOW ||
      run.repository?.full_name !== repository ||
      !["push", "workflow_dispatch"].includes(run.event)
    )
      continue;
    const bytes = await api.request(
      "GET",
      `/actions/artifacts/${artifact.id}/zip`,
      undefined,
      "bytes",
    );
    const certification = readCertificationArchive(bytes, artifact.digest);
    const staging = verifyStagingReleaseCertification({
      certification,
      run,
      artifact,
      expectedRepository: repository,
      expectedTreeSha: treeSha,
      expectedWorkflowSha256: workflowSha256,
      ...(now === undefined ? {} : { now }),
    });
    return {
      ...staging,
      mainValidation,
      expiresAt: new Date(
        Math.min(
          Date.parse(staging.expiresAt),
          Date.parse(mainValidation.expiresAt),
        ),
      ).toISOString(),
    };
  }
  throw new Error(
    "Production effects require an unexpired successful staging certification for the promoted tree",
  );
}

/** The admission can expire while a workflow waits; every later mutation boundary must recheck its verified expiry. */
export function assertProductionCertificationFresh(
  expiresAt,
  now = Date.now(),
) {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires) || now >= expires)
    throw new Error("Production certification expired before mutation");
}

/** A read-only artifact client for protected jobs; no ref, environment, or deployment mutation is exposed. */
export function certificationApi({
  repository,
  token,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !token)
    throw new Error(
      "Production certification requires repository and GitHub read credentials",
    );
  return {
    async request(method, endpoint, _body, mode) {
      if (method !== "GET")
        throw new Error("Certification only permits GitHub reads");
      const response = await fetchImpl(
        `${apiUrl.replace(/\/$/, "")}/repos/${repository}${endpoint}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!response.ok)
        throw new Error(
          `Certification GitHub read failed (${response.status})`,
        );
      return mode === "bytes"
        ? Buffer.from(await response.arrayBuffer())
        : response.json();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const validationOnly = process.argv[2] === "main-validation";
  const sourceSha = process.argv[validationOnly ? 3 : 2];
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha ?? "") ||
    process.env.GITHUB_REF_NAME !== "main"
  )
    throw new Error("Production certification requires a full main source SHA");
  const repoRoot = process.cwd();
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (head !== sourceSha)
    throw new Error(
      "Production certification checkout differs from requested source",
    );
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    encoding: "utf8",
  }).trim();
  const repository = process.env.GITHUB_REPOSITORY;
  const proof = await (validationOnly
    ? requireMainValidation
    : requireProductionCertification)({
    api: certificationApi({
      repository,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    }),
    repository,
    treeSha,
    sourceSha,
    repoRoot,
  });
  assertProductionCertificationFresh(proof.expiresAt);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `expires_epoch=${Math.floor(Date.parse(proof.expiresAt) / 1000)}\n`,
    );
  process.stdout.write(
    `Production source ${sourceSha} admitted by ${validationOnly ? "main Full" : "staging and main Full"} evidence until ${proof.expiresAt}\n`,
  );
}
