/**
 * Binds a trusted develop verifier to a served ancestor without checking out
 * older code. Changed verifier contracts require an exact operator acknowledgement;
 * source and deployment identities remain distinct throughout the evidence.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const CONTRACT_PATHS = [
  ".github/workflows/cloud-latency-certification.yml",
  "packages/cloud/scripts/chat-latency.mjs",
  "packages/cloud/scripts/inference-auth-latency.mjs",
  "packages/cloud/scripts/cloud-latency-certification.mjs",
  "packages/cloud/scripts/cloudflare-inference-trace-evidence.mjs",
  "packages/cloud/scripts/latency-certification-provenance.mjs",
];

async function git(args, cwd) {
  try {
    const result = await execute("git", args, {
      cwd,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch (cause) {
    // error-policy:J2 never expose git stderr, remote URLs, or subprocess environment.
    throw new Error("Certification source ancestry could not be proven", {
      cause,
    });
  }
}

export async function verifyCertificationSource(
  { sourceRef, sourceSha, deploySha, acknowledgedContractDigest = "" },
  { cwd = process.cwd() } = {},
) {
  if (
    sourceRef !== "refs/heads/develop" ||
    !SHA.test(sourceSha) ||
    !SHA.test(deploySha)
  ) {
    throw new Error(
      "Certification requires trusted develop source and exact commit identities",
    );
  }
  if (
    acknowledgedContractDigest !== "" &&
    !/^[a-f0-9]{64}$/.test(acknowledgedContractDigest)
  ) {
    throw new Error("Invalid verifier contract acknowledgement");
  }
  if ((await git(["rev-parse", "HEAD"], cwd)).trim() !== sourceSha) {
    throw new Error(
      "Certification checkout does not match trusted workflow source",
    );
  }
  if ((await git(["cat-file", "-t", deploySha], cwd)).trim() !== "commit") {
    throw new Error("Deployment identity is not a commit");
  }
  await git(["merge-base", "--is-ancestor", deploySha, sourceSha], cwd);
  const changes = await git(
    [
      "diff",
      "--raw",
      "--full-index",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      deploySha,
      sourceSha,
      "--",
      ...CONTRACT_PATHS,
    ],
    cwd,
  );
  const contractDigest = createHash("sha256").update(changes).digest("hex");
  const changedVerifierPaths = changes
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t")[1]);
  if (changedVerifierPaths.some((path) => !CONTRACT_PATHS.includes(path))) {
    throw new Error("Unexpected verifier contract path");
  }
  const contractChanged = changes.length > 0;
  if (contractChanged && acknowledgedContractDigest !== contractDigest) {
    throw new Error(
      `Verifier contract changes require acknowledgement: ${contractDigest}`,
    );
  }
  if (!contractChanged && acknowledgedContractDigest !== "") {
    throw new Error("Verifier contract acknowledgement is not applicable");
  }
  return {
    kind: "certification_source",
    sourceSha,
    deploySha,
    relationship: sourceSha === deploySha ? "identical" : "develop_ancestor",
    verifierContractChanged: contractChanged,
    verifierContractDigest: contractDigest,
    changedVerifierPaths,
    verifierContractAcknowledged: contractChanged,
  };
}

/** A successful measurement is valid only while its deployment remains unchanged. */
export async function withVerifiedDeployment(deploySha, verify, measure) {
  const before = await verify(deploySha);
  const result = await measure(before);
  await verify(deploySha);
  return result;
}
