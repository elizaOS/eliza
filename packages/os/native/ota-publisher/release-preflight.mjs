import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDescriptorJson } from "./strict-json.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(ok, message) {
  if (!ok) throw Error(`OTA preflight: ${message}`);
}
function readDescriptor(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    requireValue(
      stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024,
      "bounded regular descriptor required",
    );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      requireValue(count > 0, "descriptor changed during read");
      offset += count;
    }
    requireValue(
      fs.readSync(fd, Buffer.alloc(1), 0, 1, null) === 0,
      "descriptor grew during read",
    );
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
/** Runs both gates afresh. Never accepts a saved success report as authority.
 * ports support deterministic tests; CLI always uses the actual verifiers. */
export async function releasePreflight(options, ports) {
  requireValue(
    typeof ports?.validateRelease === "function" &&
      typeof ports.verifyArtifacts === "function" &&
      typeof ports.verifyPublic === "function",
    "release validation and artifact/public verification ports required",
  );
  const hosts = Object.freeze([...options.hosts]);
  const bytes = readDescriptor(options.descriptorFile),
    descriptorSha256 = digest(bytes);
  const descriptor = ports.validateRelease(parseDescriptorJson(bytes), {
    artifactHosts: new Set(hosts),
  });
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-ota-preflight-"),
  );
  fs.chmodSync(temporary, 0o700);
  const snapshot = path.join(temporary, "descriptor.json");
  try {
    fs.writeFileSync(snapshot, bytes, { flag: "wx", mode: 0o400 });
    const local = await ports.verifyArtifacts({
      ...options,
      hosts,
      descriptorFile: snapshot,
    });
    requireValue(
      local?.contractValid === true &&
        local.apkBytesVerified === true &&
        local.descriptorSha256 === descriptorSha256,
      "local APK evidence does not bind this descriptor",
    );
    requireValue(
      local.releaseId === descriptor.releaseId &&
        local.channel === descriptor.channel &&
        local.distribution === descriptor.distribution,
      "local release identity mismatch",
    );
    for (const name of ["candidate", "recovery"]) {
      const expected = descriptor[name],
        actual = local.artifacts?.[name];
      requireValue(
        actual?.sha256 === expected.sha256 &&
          actual.length === expected.length &&
          actual.versionCode === expected.versionCode &&
          actual.signerSha256 === expected.signerSha256 &&
          actual.signerSha256 === options.expectedSigner &&
          actual.runtimeVerified === true,
        `${name} local subject mismatch`,
      );
    }
    requireValue(
      digest(readDescriptor(snapshot)) === descriptorSha256,
      "private descriptor changed",
    );
    // Parse a new object so an injected verifier cannot mutate the expected one.
    const remote = await ports.verifyPublic(parseDescriptorJson(bytes), {
      hosts,
    });
    requireValue(
      remote?.publicReleaseVerified === true &&
        remote.repository === descriptor.source.repository &&
        remote.tag === descriptor.source.tag &&
        remote.commit === descriptor.source.commit &&
        Number.isSafeInteger(remote.releaseId) &&
        remote.releaseId > 0,
      "remote source identity mismatch",
    );
    for (const name of ["candidate", "recovery"]) {
      const expected = descriptor[name],
        actual = remote.subjects?.[name];
      requireValue(
        actual?.sha256 === expected.sha256 &&
          actual.length === expected.length &&
          actual.url === expected.url &&
          Number.isSafeInteger(actual.id) &&
          actual.id > 0,
        `${name} remote subject mismatch`,
      );
    }
    return {
      schemaVersion: 1,
      preflightPassed: true,
      descriptorSha256,
      releaseId: descriptor.releaseId,
      channel: descriptor.channel,
      distribution: descriptor.distribution,
      source: descriptor.source,
      local,
      remote,
      metadataAuthenticated: false,
      published: false,
      scope:
        "Fresh local APK verification and anonymous immutable GitHub readback for identical descriptor subjects. This report is not signing authority or a resumable publication token. TUF signing, source/provenance approval and dependency-first publication remain separate.",
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
