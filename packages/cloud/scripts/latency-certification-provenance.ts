/**
 * Binds a trusted staging verifier to a served ancestor without checking out
 * older code. Changed verifier contracts require an exact operator acknowledgement;
 * source and deployment identities remain distinct throughout the evidence.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const CONTRACT_PATHS = [
  "packages/cloud/api/wrangler.toml",
  ".github/workflows/cloud-latency-certification.yml",
  "packages/cloud/scripts/chat-latency.ts",
  "packages/cloud/scripts/inference-auth-latency.ts",
  "packages/cloud/scripts/cloud-latency-certification.ts",
  "packages/cloud/scripts/cloudflare-inference-trace-evidence.ts",
  "packages/cloud/scripts/latency-certification-provenance.ts",
];

/** Read deployment policy from committed bytes, never from the newer checkout. */
export async function readDeploymentPlacement(
  deploySha,
  { cwd = process.cwd() } = {},
) {
  if (!SHA.test(deploySha))
    throw new Error("Invalid placement deployment identity");
  const source = await git(
    ["show", `${deploySha}:packages/cloud/api/wrangler.toml`],
    cwd,
  );
  let config: {
    staging: boolean;
    placement: { mode: string; region: string } | null;
    rootPlacement: unknown;
  };
  try {
    // The certification workflow already pins Bun. Use its TOML parser without
    // installing dependencies or executing code from the deployed revision.
    config = JSON.parse(
      execFileSync(
        "bun",
        [
          "--eval",
          `
      const config = Bun.TOML.parse(await Bun.stdin.text());
      console.log(JSON.stringify({
        staging: Boolean(config.env?.staging),
        placement: config.env?.staging?.placement ?? null,
        rootPlacement: config.placement ?? null,
      }));
    `,
        ],
        {
          cwd,
          input: source,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 64 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    );
  } catch (cause) {
    // error-policy:J2 parsing failures must not expose the deployment configuration.
    throw new Error("Deployment placement configuration could not be parsed", {
      cause,
    });
  }
  if (
    config.staging !== true ||
    (config.placement === null && config.rootPlacement !== null)
  )
    throw new Error("Deployment requires an explicit staging placement policy");
  const placement = config.placement;
  if (
    placement !== null &&
    (typeof placement !== "object" ||
      Array.isArray(placement) ||
      placement.mode !== "targeted" ||
      typeof placement.region !== "string" ||
      !/^[a-z0-9]+:[a-z0-9-]+$/.test(placement.region) ||
      Object.keys(placement).some((key) => key !== "mode" && key !== "region"))
  )
    throw new Error("Unsupported deployment placement policy");
  return {
    kind: "deployment_placement",
    deploySha,
    configSha256: createHash("sha256").update(source).digest("hex"),
    ...(placement === null ? { mode: "default" } : placement),
  };
}

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
    sourceRef !== "refs/heads/staging" ||
    !SHA.test(sourceSha) ||
    !SHA.test(deploySha)
  ) {
    throw new Error(
      "Certification requires trusted staging source and exact commit identities",
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
