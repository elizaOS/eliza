import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDescriptorJson } from "./strict-json.mjs";

function requireValue(value, message) {
  if (!value) throw Error(`OTA artifact gate: ${message}`);
}
export function manifestTree(xml) {
  const roots = [],
    stack = [];
  for (const line of xml.split("\n")) {
    const element = /^(\s*)E: ([A-Za-z0-9_-]+) \(line=\d+\)$/.exec(line);
    if (element) {
      const depth = element[1].length,
        node = { name: element[2], attributes: {}, children: [] };
      while (stack.length && stack.at(-1).depth >= depth) stack.pop();
      (stack.length ? stack.at(-1).node.children : roots).push(node);
      stack.push({ depth, node });
      continue;
    }
    const attribute =
      /^(\s*)A: ([A-Za-z0-9_:-]+)(?:\(0x[0-9a-f]+\))?=(.*)$/.exec(line);
    if (attribute) {
      requireValue(
        stack.length && attribute[1].length > stack.at(-1).depth,
        "invalid manifest attribute nesting",
      );
      const attrs = stack.at(-1).node.attributes;
      requireValue(
        !Object.hasOwn(attrs, attribute[2]),
        "duplicate manifest attribute",
      );
      attrs[attribute[2]] = attribute[3];
    }
  }
  requireValue(
    roots.length === 1 && roots[0].name === "manifest",
    "manifest root",
  );
  return roots[0];
}
function string(value) {
  return /^"([^"\r\n]*)"(?: \(Raw: "[^"\r\n]*"\))?$/.exec(value ?? "")?.[1];
}
function integer(value) {
  const hex = /^\(type 0x10\)0x([0-9a-f]+)$/.exec(value ?? "");
  return hex ? parseInt(hex[1], 16) : NaN;
}
function flag(value) {
  if (value === undefined) return false;
  requireValue(
    /^\(type 0x12\)0x(?:0|ffffffff)$/.test(value),
    "unsupported boolean manifest flag",
  );
  return !value.endsWith(")0x0");
}
function one(parent, name) {
  const children = parent.children.filter((n) => n.name === name);
  requireValue(children.length === 1, `exactly one ${name} required`);
  return children[0];
}
export function createArtifactVerifier({
  validateRelease,
  otaTrustSource,
  androidEnv,
  tool,
  distributionMetadataKey,
} = {}) {
  for (const port of [validateRelease, otaTrustSource, androidEnv, tool])
    requireValue(
      typeof port === "function",
      "host verification ports required",
    );
  requireValue(
    typeof distributionMetadataKey === "string" &&
      /^[a-zA-Z][a-zA-Z0-9_.]{0,255}$/.test(distributionMetadataKey),
    "distribution metadata key required",
  );
  function verifyManifest(xml, descriptor, artifact) {
    const manifest = manifestTree(xml),
      app = one(manifest, "application"),
      sdk = one(manifest, "uses-sdk");
    requireValue(
      string(manifest.attributes.package) === descriptor.packageId,
      "package mismatch",
    );
    requireValue(
      (manifest.attributes["android:versionCodeMajor"] === undefined ||
        integer(manifest.attributes["android:versionCodeMajor"]) === 0) &&
        integer(manifest.attributes["android:versionCode"]) ===
          artifact.versionCode &&
        string(manifest.attributes["android:versionName"]) ===
          artifact.versionName,
      "version mismatch",
    );
    requireValue(
      !flag(app.attributes["android:debuggable"]) &&
        !flag(app.attributes["android:testOnly"]),
      "debug/test APK forbidden",
    );
    requireValue(
      integer(sdk.attributes["android:minSdkVersion"]) >= 1 &&
        integer(sdk.attributes["android:minSdkVersion"]) <=
          artifact.android.sdk.min &&
        integer(sdk.attributes["android:targetSdkVersion"]) ===
          artifact.android.targetSdk,
      "SDK contract mismatch",
    );
    requireValue(
      sdk.attributes["android:maxSdkVersion"] === undefined ||
        integer(sdk.attributes["android:maxSdkVersion"]) >=
          artifact.android.sdk.max,
      "max SDK excludes qualified devices",
    );
    const distribution = app.children.filter(
      (n) =>
        n.name === "meta-data" &&
        string(n.attributes["android:name"]) === distributionMetadataKey,
    );
    requireValue(
      distribution.length === 1 &&
        string(distribution[0].attributes["android:value"]) ===
          descriptor.distribution,
      "distribution metadata mismatch",
    );
    const categories = app.children
      .filter((n) => ["activity", "activity-alias"].includes(n.name))
      .flatMap((n) => n.children.filter((c) => c.name === "intent-filter"))
      .filter((n) =>
        n.children.some(
          (c) =>
            c.name === "action" &&
            string(c.attributes["android:name"]) ===
              "android.intent.action.MAIN",
        ),
      )
      .flatMap((n) =>
        n.children
          .filter((c) => c.name === "category")
          .map((c) => string(c.attributes["android:name"])),
      );
    requireValue(
      categories.includes("android.intent.category.LAUNCHER") &&
        categories.includes("android.intent.category.HOME") ===
          (descriptor.distribution === "launcher"),
      "HOME/launcher contract mismatch",
    );
  }
  function snapshot(input, destination, max) {
    const source = fs.openSync(
      input,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let output;
    try {
      const stat = fs.fstatSync(source);
      requireValue(
        stat.isFile() && stat.size > 0 && stat.size <= max,
        "input must be a bounded regular file",
      );
      output = fs.openSync(destination, "wx", 0o600);
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(1024 * 1024);
      let size = 0,
        n;
      while (true) {
        n = fs.readSync(source, buffer, 0, buffer.length, null);
        if (n === 0) break;
        size += n;
        requireValue(size <= max, "input grew beyond limit");
        hash.update(buffer.subarray(0, n));
        let offset = 0;
        while (offset < n)
          offset += fs.writeSync(output, buffer, offset, n - offset);
      }
      requireValue(size === stat.size, "input changed while snapshotting");
      return { length: size, sha256: hash.digest("hex") };
    } finally {
      fs.closeSync(source);
      if (output !== undefined) fs.closeSync(output);
    }
  }
  function verifyReleaseArtifacts({
    descriptorFile,
    candidate,
    recovery,
    expectedSigner,
    hosts,
  }) {
    requireValue(
      /^[a-f0-9]{64}$/.test(expectedSigner ?? ""),
      "independent expected signer pin required",
    );
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-release-gate-"));
    fs.chmodSync(temp, 0o700);
    try {
      const descriptorPath = path.join(temp, "descriptor.json");
      const descriptorIdentity = snapshot(
        descriptorFile,
        descriptorPath,
        1024 * 1024,
      );
      const descriptor = validateRelease(
        parseDescriptorJson(fs.readFileSync(descriptorPath)),
        { artifactHosts: new Set(hosts) },
      );
      const binary = path.join(temp, "verify-runtime");
      const { source, ldflags } = otaTrustSource();
      execFileSync(
        "go",
        ["build", `-ldflags=${ldflags}`, "-o", binary, "./cmd/verify-runtime"],
        {
          cwd: source,
          encoding: "utf8",
          timeout: 180000,
          maxBuffer: 1024 * 1024,
        },
      );
      const artifacts = {};
      for (const [name, input] of Object.entries({ candidate, recovery })) {
        const artifact = descriptor[name];
        requireValue(
          artifact.signerSha256 === expectedSigner,
          "descriptor signer differs from release signing policy",
        );
        const apk = path.join(temp, `${name}.apk`),
          identity = snapshot(input, apk, 1024 ** 3);
        requireValue(
          identity.length === artifact.length &&
            identity.sha256 === artifact.sha256,
          `${name} bytes mismatch`,
        );
        const certificates = execFileSync(
          tool("apksigner"),
          [
            "verify",
            "--min-sdk-version",
            String(artifact.android.sdk.min),
            "--print-certs",
            apk,
          ],
          {
            env: androidEnv(),
            encoding: "utf8",
            timeout: 60000,
            maxBuffer: 1024 * 1024,
          },
        );
        const signers = [
          ...certificates.matchAll(
            /^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]{64})$/gm,
          ),
        ];
        requireValue(
          signers.length === 1 && signers[0][1] === expectedSigner,
          `${name} APK signer mismatch`,
        );
        const xml = execFileSync(
          tool("aapt"),
          ["dump", "xmltree", apk, "AndroidManifest.xml"],
          { encoding: "utf8", timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
        );
        verifyManifest(xml, descriptor, artifact);
        const metadata = path.join(temp, `${name}.json`);
        fs.writeFileSync(metadata, JSON.stringify(artifact), { mode: 0o600 });
        execFileSync(
          binary,
          [
            "-apk",
            apk,
            "-artifact",
            metadata,
            "-hosts",
            hosts.join(","),
            "-abis",
            artifact.android.abis.join(","),
          ],
          { encoding: "utf8", timeout: 180000, maxBuffer: 1024 * 1024 },
        );
        artifacts[name] = {
          ...identity,
          signerSha256: expectedSigner,
          versionCode: artifact.versionCode,
          runtimeVerified: true,
        };
      }
      return {
        contractValid: true,
        apkBytesVerified: true,
        authenticated: false,
        descriptorSha256: descriptorIdentity.sha256,
        releaseId: descriptor.releaseId,
        distribution: descriptor.distribution,
        channel: descriptor.channel,
        artifacts,
        scope:
          "Prepublication APK gate only. TUF authorization, reviewed source/provenance, data migration, health and physical qualification are separate.",
      };
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  return Object.freeze({ verifyManifest, verifyReleaseArtifacts });
}
