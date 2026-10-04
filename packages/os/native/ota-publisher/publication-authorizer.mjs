import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  advancePublisherPolicy,
  readPublisherPolicy,
} from "./publisher-policy.mjs";

const execute = promisify(execFile),
  hash = (b) => createHash("sha256").update(b).digest("hex");
const requireValue = (ok, message) => {
  if (!ok) throw Error(`OTA publication authorization: ${message}`);
};
export async function verifyPublicationGraph({
  executable,
  root,
  bundle,
  policy,
  directory,
  timeoutMs,
}) {
  requireValue(
    path.isAbsolute(executable),
    "absolute provisioned verifier required",
  );
  for (const [name, bytes] of [
    ["root", root],
    ["bundle", Buffer.from(JSON.stringify(bundle))],
    ["policy", Buffer.from(JSON.stringify(policy))],
  ])
    fs.writeFileSync(path.join(directory, `${name}.json`), bytes, {
      flag: "wx",
      mode: 0o400,
    });
  const { stdout } = await execute(
    executable,
    [
      "-root",
      path.join(directory, "root.json"),
      "-bundle",
      path.join(directory, "bundle.json"),
      "-policy",
      path.join(directory, "policy.json"),
    ],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
/** Provisioned publisher composition. Each invocation obtains fresh qualified
 * policy and source approval and reruns every artifact/public-release preflight.
 * Call from the transaction's authorizeBundle port, including its pre-CAS call.
 * No saved report grants authority. Policy persistence and storage are separate.
 */
export function createPublicationAuthorizer(options, ports) {
  requireValue(
    typeof ports?.verifyGraph === "function" &&
      typeof ports.preflight === "function",
    "graph and preflight verification ports required",
  );
  requireValue(
    Buffer.isBuffer(options.root) &&
      options.root.length > 0 &&
      options.root.length <= 1024 * 1024,
    "provisioned root required",
  );
  requireValue(
    typeof options.readPolicy === "function" &&
      typeof options.approveSource === "function",
    "fresh policy and source approval providers required",
  );
  const root = Buffer.from(options.root),
    hosts = Object.freeze([...options.hosts]);
  const artifacts = structuredClone(options.artifacts),
    executable = options.executable;
  return async function authorizeBundle(plan) {
    requireValue(
      Buffer.isBuffer(plan.timestamp) &&
        plan.timestamp.length <= 16384 &&
        Array.isArray(plan.dependencies) &&
        plan.dependencies.length <= 128,
      "bounded bundle required",
    );
    const files = Object.create(null),
      descriptors = new Map();
    files["timestamp.json"] = Buffer.from(plan.timestamp);
    let size = files["timestamp.json"].length;
    for (const item of plan.dependencies) {
      requireValue(
        typeof item.name === "string" &&
          !Object.hasOwn(files, item.name) &&
          Buffer.isBuffer(item.bytes) &&
          item.bytes.length > 0 &&
          item.bytes.length <= 1024 * 1024,
        "invalid dependency",
      );
      const bytes = Buffer.from(item.bytes);
      files[item.name] = bytes;
      size += bytes.length;
      requireValue(size <= 64 * 1024 * 1024, "bundle budget");
      const match =
        /^targets\/(stable|beta)\/([a-f0-9]{64})\.(launcher|standalone)\.json$/.exec(
          item.name,
        );
      if (match) {
        const target = `${match[1]}/${match[3]}.json`;
        requireValue(
          !descriptors.has(target) && hash(bytes) === match[2],
          "duplicate or mismatched descriptor",
        );
        descriptors.set(target, bytes);
      }
    }
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-ota-publication-auth-"),
    );
    fs.chmodSync(directory, 0o700);
    try {
      const verify = async (name) => {
        const stage = path.join(directory, name);
        fs.mkdirSync(stage, { mode: 0o700 });
        return ports.verifyGraph({
          executable,
          root: Buffer.from(root),
          bundle: {
            files: Object.fromEntries(
              Object.entries(files).map(([k, b]) => [k, b.toString("base64")]),
            ),
          },
          policy: structuredClone(await options.readPolicy()),
          directory: stage,
        });
      };
      const graph = await verify("initial");
      requireValue(
        graph?.graphVerified === true &&
          graph.timestampSha256 === hash(files["timestamp.json"]),
        "graph evidence mismatch",
      );
      requireValue(
        descriptors.size > 0 &&
          isDeepStrictEqual(
            Object.keys(graph.descriptors ?? {}).sort(),
            [...descriptors.keys()].sort(),
          ),
        "graph descriptor set mismatch",
      );
      const reports = [];
      for (const [target, bytes] of descriptors) {
        requireValue(
          isDeepStrictEqual(JSON.parse(bytes), graph.descriptors[target]),
          "graph descriptor subject mismatch",
        );
        const artifact = artifacts[target];
        requireValue(
          artifact && typeof artifact.expectedSigner === "string",
          "independent artifact/signing policy missing",
        );
        const descriptorSha256 = hash(bytes),
          descriptorFile = path.join(directory, `${reports.length}.json`);
        fs.writeFileSync(descriptorFile, bytes, { flag: "wx", mode: 0o400 });
        const approval = await options.approveSource({
          target,
          descriptor: JSON.parse(bytes),
          descriptorSha256,
        });
        requireValue(
          approval?.approved === true &&
            approval.descriptorSha256 === descriptorSha256,
          "source approval missing or stale",
        );
        const report = await ports.preflight({
          ...artifact,
          hosts,
          descriptorFile,
        });
        requireValue(
          report?.preflightPassed === true &&
            report.descriptorSha256 === descriptorSha256 &&
            `${report.channel}/${report.distribution}.json` === target,
          "release preflight subject mismatch",
        );
        reports.push({ target, descriptorSha256 });
      }
      const finalGraph = await verify("final");
      requireValue(
        isDeepStrictEqual(finalGraph, graph),
        "graph changed during release verification",
      );
      return {
        authorized: true,
        timestampSha256: graph.timestampSha256,
        versions: graph.versions,
        descriptors: reports,
        published: false,
      };
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** Complete local publisher gate; production storage and trust providers must
 * be provisioned. The storage object cannot override bundle authorization. */
export async function publishAuthorizedMetadata(
  journal,
  plan,
  options,
  storage,
  verificationPorts,
) {
  const { publishMetadataTransaction } = await import(
    "./publication-transaction.mjs"
  );
  return publishMetadataTransaction(journal, plan, {
    authorizeBundle: createPublicationAuthorizer(options, verificationPorts),
    read: (name) => storage.read(name),
    putImmutable: (name, bytes) => storage.putImmutable(name, bytes),
    compareAndSwapTimestamp: (previous, bytes) =>
      storage.compareAndSwapTimestamp(previous, bytes),
  });
}

/** Production composition with provisioned durable floors. Qualified time and
 * source approval still come from trusted deployment-specific providers. */
export async function publishWithDurablePolicy(
  journal,
  plan,
  options,
  storage,
  verificationPorts,
) {
  requireValue(
    typeof options.qualifiedUpperMs === "function" &&
      typeof options.policyFile === "string",
    "durable policy and qualified time provider required",
  );
  const authorize = createPublicationAuthorizer(
    {
      ...options,
      readPolicy: async () =>
        readPublisherPolicy(
          options.policyFile,
          await options.qualifiedUpperMs(),
        ),
    },
    verificationPorts,
  );
  const { publishMetadataTransaction } = await import(
    "./publication-transaction.mjs"
  );
  return publishMetadataTransaction(journal, plan, {
    authorizeBundle: async (bundle) => {
      const result = await authorize(bundle);
      advancePublisherPolicy(options.policyFile, result.versions);
      return result;
    },
    read: (name) => storage.read(name),
    putImmutable: (name, bytes) => storage.putImmutable(name, bytes),
    compareAndSwapTimestamp: (previous, bytes) =>
      storage.compareAndSwapTimestamp(previous, bytes),
  });
}
