import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { parseDescriptorJson } from "./strict-json.mjs";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roles = Object.freeze([
  "root",
  "timestamp",
  "snapshot",
  "targets",
  "stable",
  "beta",
]);
const descriptorPath =
  /^targets\/(stable|beta)\/([a-f0-9]{64})\.(launcher|standalone)\.json$/;
const fail = (ok, message) => {
  if (!ok) throw Error(`OTA publication authorizer: ${message}`);
};
const MAX_TIMER_MS = 2147483647;

function validVersions(versions) {
  return (
    versions !== null &&
    typeof versions === "object" &&
    Object.keys(versions).length === roles.length &&
    roles.every((r) => Number.isSafeInteger(versions[r]) && versions[r] > 0)
  );
}
function validPolicy(policy) {
  return (
    Number.isSafeInteger(policy?.trustedUpperMs) &&
    policy.trustedUpperMs > 0 &&
    validVersions(policy.minimumVersions)
  );
}
function copyPlan(plan) {
  return {
    id: plan.id,
    timestamp: Buffer.from(plan.timestamp),
    dependencies: plan.dependencies.map(({ name, bytes }) => ({
      name,
      bytes: Buffer.from(bytes),
    })),
  };
}

/** Runs the shared offline graph verifier (`ota-trust/cmd/verify-publication`)
 * on one publication plan. The host supplies the reviewed executable, the
 * provisioned root, a policy holding qualified publisher time and durable role
 * floors, cancellation and a deadline; nothing here has a default. Inputs are
 * written as private read-only files in a private temporary directory. The
 * report must bind the exact timestamp bytes of this plan. */
export async function verifyPublicationGraph({
  executable,
  root,
  bundle,
  policy,
  signal,
  timeoutMs,
} = {}) {
  fail(
    typeof executable === "string" && path.isAbsolute(executable),
    "absolute verifier executable required",
  );
  fail(signal instanceof AbortSignal, "host cancellation signal required");
  fail(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= MAX_TIMER_MS,
    "host verifier deadline required",
  );
  fail(
    Buffer.isBuffer(root) && root.length > 0 && root.length <= 1024 * 1024,
    "provisioned root required",
  );
  fail(validPolicy(policy), "qualified time and complete role floors required");
  fail(
    bundle &&
      Buffer.isBuffer(bundle.timestamp) &&
      Array.isArray(bundle.dependencies),
    "publication plan required",
  );
  signal.throwIfAborted();
  const files = Object.create(null);
  files["timestamp.json"] = bundle.timestamp.toString("base64");
  for (const { name, bytes } of bundle.dependencies) {
    fail(
      typeof name === "string" && !Object.hasOwn(files, name),
      "duplicate publication path",
    );
    files[name] = Buffer.from(bytes).toString("base64");
  }
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ota-publication-graph-"),
  );
  try {
    await fs.chmod(directory, 0o700);
    const write = async (name, data) => {
      const file = path.join(directory, name);
      await fs.writeFile(file, data, { flag: "wx", mode: 0o400 });
      return file;
    };
    const args = [
      "-root",
      await write("root.json", root),
      "-bundle",
      await write("bundle.json", JSON.stringify({ files })),
      "-policy",
      await write("policy.json", JSON.stringify(policy)),
    ];
    const { stdout } = await execute(executable, args, {
      signal,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    let report;
    try {
      report = JSON.parse(stdout);
    } catch {
      fail(false, "verifier output is not JSON");
    }
    fail(
      report?.graphVerified === true &&
        report.timestampSha256 === hash(bundle.timestamp),
      "verifier report does not bind this timestamp",
    );
    return report;
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Returns the `authorizeBundle` port for publishMetadataTransaction.
 *
 * Each call (before any write, and again immediately before the timestamp
 * CAS) reads the durable policy, verifies the complete signed graph, binds
 * every descriptor in the plan to that graph, obtains a fresh source approval
 * and a fresh preflight report for each exact descriptor, verifies the graph
 * again under freshly read policy, and only then advances the role floors to
 * the verified versions. A saved report or approval is never reused.
 *
 * Ports (all host-owned, all awaited):
 * - readPolicy() -> { trustedUpperMs, minimumVersions }: qualified publisher
 *   time and durable floors (for example readPublisherPolicy).
 * - verifyGraph({ root, bundle, policy }) -> graph report: for example
 *   verifyPublicationGraph with the host's executable, signal and deadline.
 *   The verifier must accept versions equal to the floors; a retried
 *   publication re-verifies at floors this function already advanced.
 * - approveSource({ path, descriptor, descriptorSha256 }) -> true.
 * - preflight({ path, descriptor, descriptorSha256 }) -> report whose
 *   descriptorSha256, channel and distribution equal this descriptor's.
 * - advancePolicy(versions): for example advancePublisherPolicy.
 *
 * Deadlines, retries and cancellation belong to the host's ports; this
 * function adds none. */
export function createPublicationAuthorizer(ports, { root } = {}) {
  for (const name of [
    "readPolicy",
    "verifyGraph",
    "approveSource",
    "preflight",
    "advancePolicy",
  ])
    fail(typeof ports?.[name] === "function", `missing ${name}`);
  fail(
    Buffer.isBuffer(root) && root.length > 0 && root.length <= 1024 * 1024,
    "provisioned root required",
  );
  const trustedRoot = Buffer.from(root);
  return async function authorizeBundle(input) {
    fail(
      input &&
        Buffer.isBuffer(input.timestamp) &&
        Array.isArray(input.dependencies) &&
        input.dependencies.length > 0,
      "publication plan required",
    );
    const plan = copyPlan(input);
    const timestampSha256 = hash(plan.timestamp);
    const descriptors = new Map();
    for (const { name, bytes } of plan.dependencies) {
      const match = descriptorPath.exec(name);
      if (!match) continue;
      const [, channel, sha256, distribution] = match;
      const key = `${channel}/${distribution}.json`;
      fail(hash(bytes) === sha256, `descriptor bytes do not match ${name}`);
      fail(!descriptors.has(key), `duplicate descriptor target ${key}`);
      // Strict parse: bounded size, UTF-8, no duplicate keys.
      parseDescriptorJson(bytes);
      descriptors.set(key, {
        path: key,
        channel,
        distribution,
        descriptorSha256: sha256,
        bytes,
      });
    }
    fail(descriptors.size > 0, "publication has no descriptor");
    const verify = async () => {
      const policy = await ports.readPolicy();
      fail(validPolicy(policy), "invalid publisher policy");
      const graph = await ports.verifyGraph({
        root: Buffer.from(trustedRoot),
        bundle: copyPlan(plan),
        policy: structuredClone(policy),
      });
      fail(
        graph?.graphVerified === true &&
          graph.timestampSha256 === timestampSha256 &&
          validVersions(graph.versions) &&
          graph.descriptors !== null &&
          typeof graph.descriptors === "object",
        "graph report does not bind this plan",
      );
      for (const role of roles)
        fail(
          graph.versions[role] >= policy.minimumVersions[role],
          `${role} version below durable floor`,
        );
      return graph;
    };
    const graph = await verify();
    fail(
      isDeepStrictEqual(
        Object.keys(graph.descriptors).sort(),
        [...descriptors.keys()].sort(),
      ),
      "plan descriptors differ from the signed graph",
    );
    for (const [key, entry] of [...descriptors].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      fail(
        isDeepStrictEqual(
          graph.descriptors[key],
          JSON.parse(entry.bytes.toString("utf8")),
        ),
        `signed graph descriptor differs for ${key}`,
      );
      const subject = () => ({
        path: entry.path,
        descriptor: JSON.parse(entry.bytes.toString("utf8")),
        descriptorSha256: entry.descriptorSha256,
      });
      fail(
        (await ports.approveSource(subject())) === true,
        `source not approved for ${key}`,
      );
      const report = await ports.preflight(subject());
      fail(
        report?.descriptorSha256 === entry.descriptorSha256 &&
          report.channel === entry.channel &&
          report.distribution === entry.distribution,
        `preflight evidence does not match ${key}`,
      );
    }
    // Policy may have advanced or expired during slow approvals and artifact
    // checks: verify again under freshly read policy and compare only what the
    // graph authenticates.
    const final = await verify();
    fail(
      final.timestampSha256 === graph.timestampSha256 &&
        isDeepStrictEqual(final.versions, graph.versions) &&
        isDeepStrictEqual(final.descriptors, graph.descriptors),
      "graph changed during release verification",
    );
    await ports.advancePolicy({ ...graph.versions });
    return Object.freeze({
      timestampSha256,
      versions: Object.freeze({ ...graph.versions }),
      descriptors: Object.freeze(
        [...descriptors.values()].map((d) => d.path).sort(),
      ),
    });
  };
}
