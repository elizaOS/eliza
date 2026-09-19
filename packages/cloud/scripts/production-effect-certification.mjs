/** Admits production effects only after the canonical staging artifact proves the promoted tree with an unexpired certificate. */
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
import { execFileSync } from "../../scripts/lib/spawn-sync-captured.mjs";
import {
  artifactNameForTree,
  CERTIFICATION_FILENAME,
  CERTIFICATION_WORKFLOW,
  verifyStagingReleaseCertification,
} from "./staging-release-certification.mjs";

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

/** Resolves only successful staging-run artifacts; a receipt or an artifact name alone cannot authorize dispatch. */
export async function requireProductionCertification({
  api,
  repository,
  treeSha,
  repoRoot,
  now,
}) {
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
    return verifyStagingReleaseCertification({
      certification,
      run,
      artifact,
      expectedRepository: repository,
      expectedTreeSha: treeSha,
      expectedWorkflowSha256: workflowSha256,
      ...(now === undefined ? {} : { now }),
    });
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
  const sourceSha = process.argv[2];
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
  const proof = await requireProductionCertification({
    api: certificationApi({
      repository,
      token: process.env.GITHUB_TOKEN,
      apiUrl: process.env.GITHUB_API_URL,
    }),
    repository,
    treeSha,
    repoRoot,
  });
  assertProductionCertificationFresh(proof.expiresAt);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `expires_epoch=${Math.floor(Date.parse(proof.expiresAt) / 1000)}\n`,
    );
  process.stdout.write(
    `Production tree ${treeSha} certified by staging run ${proof.runId} until ${proof.expiresAt}\n`,
  );
}
