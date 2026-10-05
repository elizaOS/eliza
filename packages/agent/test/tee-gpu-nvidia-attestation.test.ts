/** Drives the NVIDIA GPU attestation verifier over real HTTPS against a local NRAS emulator that signs ES384 detached EAT bundles, and through a real sha256-pinned collector process: only a fully verified bundle yields gpuProtected/gpuFirmware, every tampered, stale, unbound or unsafe response is rejected with a typed reason. */
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  gpuClaimsFromVerifiedNvidiaAttestation,
  type NvidiaGpuAttestationConfig,
  NvidiaGpuAttestationVerifier,
  type NvidiaGpuEvidence,
  type NvidiaGpuVerifiedClaims,
  nvidiaGpuAttestationFailureReason,
} from "../src/services/tee-gpu-nvidia.ts";

const ISSUER = "https://nras.attestation.nvidia.com";
const KID = "nv-eat-kid-test-1";
const EVIDENCE: NvidiaGpuEvidence = {
  arch: "HOPPER",
  evidence_list: [{ evidence: "ZXZpZGVuY2U=", certificate: "Y2VydA==" }],
};

type Reply = { status: number; headers?: Record<string, string>; body: string };
type Responder = (request: {
  nonce: string;
  body: Record<string, unknown>;
}) => Reply;

let dir: string;
let server: Server;
let origin: string;
let caPem: string;
let signingKey: KeyObject;
let publicJwk: Record<string, unknown>;
let chainKey: KeyObject;
let chainJwk: Record<string, unknown>;
let chainAnchorSha256: string;
let collectorPath: string;
let collectorSha256: string;
let responder: Responder;
let jwksBody: string;
const requests: Array<{ method: string; url: string; body: string }> = [];

function openssl(args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
}

function jwt(
  payload: Record<string, unknown>,
  options: { key?: KeyObject; header?: Record<string, unknown> } = {},
): string {
  const header = options.header ?? { alg: "ES384", kid: KID };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = sign("sha384", Buffer.from(input), {
    key: options.key ?? signingKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

function times(): Record<string, number> {
  const now = Math.floor(Date.now() / 1000);
  return { iat: now, nbf: now - 5, exp: now + 3600 };
}

function chainClaim(): Record<string, unknown> {
  return {
    "x-nvidia-cert-expiration-date": "2030-01-01T00:00:00",
    "x-nvidia-cert-status": "valid",
    "x-nvidia-cert-ocsp-status": "good",
    "x-nvidia-cert-revocation-reason": null,
  };
}

function gpuClaims(nonce: string): Record<string, unknown> {
  return {
    iss: ISSUER,
    ...times(),
    jti: "gpu-0",
    eat_nonce: nonce,
    measres: "success",
    secboot: true,
    dbgstat: "disabled",
    hwmodel: "GH100 A01 GSP BROM",
    ueid: "490457405999046854973671575630853621547794591064",
    oemid: "5703",
    "x-nvidia-gpu-driver-version": "575.28",
    "x-nvidia-gpu-vbios-version": "96.00.AF.00.01",
    "x-nvidia-gpu-arch-check": true,
    "x-nvidia-gpu-attestation-report-parsed": true,
    "x-nvidia-gpu-attestation-report-nonce-match": true,
    "x-nvidia-gpu-attestation-report-signature-verified": true,
    "x-nvidia-gpu-attestation-report-cert-chain-fwid-match": true,
    "x-nvidia-gpu-attestation-report-cert-chain": chainClaim(),
    "x-nvidia-gpu-driver-rim-fetched": true,
    "x-nvidia-gpu-driver-rim-schema-validated": true,
    "x-nvidia-gpu-driver-rim-signature-verified": true,
    "x-nvidia-gpu-driver-rim-version-match": true,
    "x-nvidia-gpu-driver-rim-measurements-available": true,
    "x-nvidia-gpu-driver-rim-cert-chain": chainClaim(),
    "x-nvidia-gpu-vbios-rim-fetched": true,
    "x-nvidia-gpu-vbios-rim-schema-validated": true,
    "x-nvidia-gpu-vbios-rim-signature-verified": true,
    "x-nvidia-gpu-vbios-rim-version-match": true,
    "x-nvidia-gpu-vbios-rim-measurements-available": true,
    "x-nvidia-gpu-vbios-rim-cert-chain": chainClaim(),
    "x-nvidia-gpu-vbios-index-no-conflict": true,
  };
}

function overallClaims(nonce: string): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: "NVIDIA-PLATFORM-ATTESTATION",
    ...times(),
    jti: "overall",
    "x-nvidia-ver": "3.0",
    "x-nvidia-overall-att-result": true,
    eat_nonce: nonce,
    submods: { "GPU-0": ["DIGEST", ["SHA-256", "ab".repeat(32)]] },
  };
}

function bundle(
  nonce: string,
  edit: {
    overall?: (claims: Record<string, unknown>) => void;
    gpu?: (claims: Record<string, unknown>) => void;
    gpuToken?: (claims: Record<string, unknown>) => string;
    key?: KeyObject;
  } = {},
): Reply {
  const overall = overallClaims(nonce);
  edit.overall?.(overall);
  const gpu = gpuClaims(nonce);
  edit.gpu?.(gpu);
  const header = edit.key
    ? { alg: "ES384", kid: "nv-eat-kid-chain" }
    : undefined;
  const opts = { key: edit.key, header };
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify([
      ["JWT", jwt(overall, opts)],
      { "GPU-0": edit.gpuToken ? edit.gpuToken(gpu) : jwt(gpu, opts) },
    ]),
  };
}

function config(
  overrides: Partial<NvidiaGpuAttestationConfig> = {},
): NvidiaGpuAttestationConfig {
  return {
    nrasUrl: `${origin}/v4/attest/gpu`,
    jwks: { source: "pinned", keys: [publicJwk as never] },
    trustedCaPem: caPem,
    timeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
    ...overrides,
  };
}

function nonce(): string {
  return randomBytes(32).toString("hex");
}

async function rejection(
  promise: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (
      nvidiaGpuAttestationFailureReason(error) ?? `untyped:${String(error)}`
    );
  }
  return "resolved";
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "eliza-nvidia-gpu-attest-"));
  // TLS identity for the NRAS emulator (pinned as the only trusted root).
  openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "tls-key.pem",
    "-out",
    "tls-cert.pem",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  // NRAS-shaped signing chain: P-384 leaf issued by a pinned P-384 CA.
  openssl([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-384",
    "-nodes",
    "-keyout",
    "ca-key.pem",
    "-out",
    "ca-cert.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Test NRAS Intermediate",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  openssl([
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-384",
    "-nodes",
    "-keyout",
    "leaf-key.pem",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=Test NRAS GPU",
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca-cert.pem",
    "-CAkey",
    "ca-key.pem",
    "-CAcreateserial",
    "-out",
    "leaf-cert.pem",
    "-days",
    "1",
  ]);
  const read = (name: string) => readFile(path.join(dir, name), "utf8");
  caPem = await read("tls-cert.pem");
  const pair = generateKeyPairSync("ec", { namedCurve: "P-384" });
  signingKey = pair.privateKey;
  publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: KID };
  chainKey = createPrivateKey(await read("leaf-key.pem"));
  const leaf = new X509Certificate(await read("leaf-cert.pem"));
  const ca = new X509Certificate(await read("ca-cert.pem"));
  chainAnchorSha256 = createHash("sha256").update(ca.raw).digest("hex");
  chainJwk = {
    ...leaf.publicKey.export({ format: "jwk" }),
    kid: "nv-eat-kid-chain",
    x5c: [leaf.raw.toString("base64"), ca.raw.toString("base64")],
  };
  collectorPath = path.join(dir, "nvattest");
  await writeFile(
    collectorPath,
    `#!/bin/sh\nprintf '{"evidences":[{"arch":"Hopper","nonce":"%s","evidence":"ZXZpZGVuY2U=","certificate":"Y2VydA=="}],"result_code":0,"result_message":"Ok"}' "$5"\n`,
  );
  await chmod(collectorPath, 0o755);
  collectorSha256 = createHash("sha256")
    .update(await readFile(collectorPath))
    .digest("hex");

  server = createServer(
    { key: await read("tls-key.pem"), cert: caPem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        if (req.method === "GET" && req.url === "/.well-known/jwks.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(jwksBody);
          return;
        }
        if (req.method !== "POST" || req.url !== "/v4/attest/gpu") {
          res.writeHead(404).end();
          return;
        }
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const reply = responder({ nonce: String(parsed.nonce), body: parsed });
        res.writeHead(reply.status, reply.headers);
        res.end(reply.body);
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  responder = ({ nonce: n }) => bundle(n);
  jwksBody = JSON.stringify({ keys: [chainJwk] });
});

describe("NvidiaGpuAttestationVerifier", () => {
  it("verifies caller evidence and derives gpuProtected/gpuFirmware only from the branded result", async () => {
    const challenge = nonce();
    const verifier = new NvidiaGpuAttestationVerifier(
      config({
        policy: {
          allowedDriverVersions: ["575.28"],
          allowedVbiosVersions: ["96.00.AF.00.01"],
          allowedHwModels: ["GH100 A01 GSP BROM"],
          expectedGpuCount: 1,
          allowedArchitectures: ["HOPPER"],
        },
      }),
    );
    const verified = await verifier.attest(challenge, { evidence: EVIDENCE });
    expect(verified.gpuProtected).toBe(true);
    expect(verified.gpuFirmware).toEqual({
      driver: "575.28",
      vbios: "96.00.AF.00.01",
    });
    expect(verified.gpus).toHaveLength(1);
    expect(verified.gpus[0]?.hwModel).toBe("GH100 A01 GSP BROM");
    expect(verified.gpuFirmwareDigest).toMatch(/^[0-9a-f]{64}$/);
    const sent = JSON.parse(requests[0]?.body ?? "{}");
    expect(sent).toEqual({
      nonce: challenge,
      arch: "HOPPER",
      evidence_list: EVIDENCE.evidence_list,
      claims_version: "3.0",
    });

    const tee = gpuClaimsFromVerifiedNvidiaAttestation(verified, challenge);
    expect(tee.claims).toEqual({ gpuProtected: true });
    expect(tee.measurements.gpuFirmware).toBe(verified.gpuFirmwareDigest);
    expect(tee.freshness.nonce).toBe(challenge);
    expect(() =>
      gpuClaimsFromVerifiedNvidiaAttestation(verified, nonce()),
    ).toThrow();
    const forged = { ...verified } as NvidiaGpuVerifiedClaims;
    expect(() =>
      gpuClaimsFromVerifiedNvidiaAttestation(forged, challenge),
    ).toThrow(/locally verified/);
  });

  it("rejects reusing one signed GPU identity for two GPU slots", async () => {
    responder = ({ nonce: challenge }) => {
      const overall = overallClaims(challenge);
      overall.submods = {
        "GPU-0": ["DIGEST", ["SHA-256", "ab".repeat(32)]],
        "GPU-1": ["DIGEST", ["SHA-256", "cd".repeat(32)]],
      };
      const token = jwt(gpuClaims(challenge));
      return {
        status: 200,
        body: JSON.stringify([
          ["JWT", jwt(overall)],
          { "GPU-0": token, "GPU-1": token },
        ]),
      };
    };
    const verifier = new NvidiaGpuAttestationVerifier(
      config({ policy: { expectedGpuCount: 2 } }),
    );
    expect(
      await rejection(
        verifier.attest(nonce(), {
          evidence: {
            ...EVIDENCE,
            evidence_list: [
              EVIDENCE.evidence_list[0],
              EVIDENCE.evidence_list[0],
            ],
          },
        }),
      ),
    ).toBe("claims");
  });

  it("accepts two distinct signed GPU identities and rejects a missing identity", async () => {
    responder = ({ nonce: challenge }) => {
      const overall = overallClaims(challenge);
      overall.submods = {
        "GPU-0": ["DIGEST", ["SHA-256", "ab".repeat(32)]],
        "GPU-1": ["DIGEST", ["SHA-256", "cd".repeat(32)]],
      };
      const second = { ...gpuClaims(challenge), ueid: "second-device" };
      return {
        status: 200,
        body: JSON.stringify([
          ["JWT", jwt(overall)],
          { "GPU-0": jwt(gpuClaims(challenge)), "GPU-1": jwt(second) },
        ]),
      };
    };
    const verifier = new NvidiaGpuAttestationVerifier(
      config({ policy: { expectedGpuCount: 2 } }),
    );
    const result = await verifier.attest(nonce(), {
      evidence: {
        ...EVIDENCE,
        evidence_list: [EVIDENCE.evidence_list[0], EVIDENCE.evidence_list[0]],
      },
    });
    expect(new Set(result.gpus.map((gpu) => gpu.ueid)).size).toBe(2);
    responder = ({ nonce: challenge }) =>
      bundle(challenge, {
        gpu: (claims) => {
          delete claims.ueid;
        },
      });
    expect(
      await rejection(
        new NvidiaGpuAttestationVerifier(config()).attest(nonce(), {
          evidence: EVIDENCE,
        }),
      ),
    ).toBe("claims");
  });

  it("accepts the documented false attestation-warning value", async () => {
    responder = ({ nonce: n }) =>
      bundle(n, {
        gpu: (claims) => {
          claims["x-nvidia-attestation-warning"] = false;
        },
      });
    const verified = await new NvidiaGpuAttestationVerifier(config()).attest(
      nonce(),
      { evidence: EVIDENCE },
    );
    expect(verified.gpuProtected).toBe(true);
  });

  it("collects evidence through the pinned collector and rejects a digest mismatch", async () => {
    const challenge = nonce();
    const verified = await new NvidiaGpuAttestationVerifier(
      config({ collector: { path: collectorPath, sha256: collectorSha256 } }),
    ).attest(challenge);
    expect(verified.architecture).toBe("HOPPER");
    expect(JSON.parse(requests[0]?.body ?? "{}").nonce).toBe(challenge);

    requests.length = 0;
    const mismatched = new NvidiaGpuAttestationVerifier(
      config({ collector: { path: collectorPath, sha256: "0".repeat(64) } }),
    );
    expect(await rejection(mismatched.attest(nonce()))).toBe("collector");
    expect(requests).toHaveLength(0);
  });

  it("verifies fetched JWKS keys only through a pinned x5c anchor", async () => {
    responder = ({ nonce: n }) => bundle(n, { key: chainKey });
    const fetched = (anchor: string) =>
      new NvidiaGpuAttestationVerifier(
        config({
          jwks: {
            source: "fetched",
            url: `${origin}/.well-known/jwks.json`,
            x5cTrustAnchorSha256: [anchor],
          },
        }),
      );
    const verified = await fetched(chainAnchorSha256).attest(nonce(), {
      evidence: EVIDENCE,
    });
    expect(verified.gpuProtected).toBe(true);
    expect(
      await rejection(
        fetched("1".repeat(64)).attest(nonce(), { evidence: EVIDENCE }),
      ),
    ).toBe("key");
  });

  it.each<[string, (n: string) => Reply, string]>([
    [
      "a bad signature",
      (n) =>
        bundle(n, {
          gpuToken: (claims) =>
            jwt(claims, {
              key: generateKeyPairSync("ec", { namedCurve: "P-384" })
                .privateKey,
            }),
        }),
      "signature",
    ],
    [
      "an HS256 token",
      (n) =>
        bundle(n, {
          gpuToken: (claims) =>
            `${Buffer.from(JSON.stringify({ alg: "HS256", kid: KID })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`,
        }),
      "algorithm",
    ],
    [
      "an unsigned alg=none token",
      (n) =>
        bundle(n, {
          gpuToken: (claims) =>
            `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`,
        }),
      "algorithm",
    ],
    ["a nonce mismatch", () => bundle(nonce()), "nonce"],
    [
      "a GPU token bound to another nonce",
      (n) =>
        bundle(n, {
          gpu: (claims) => {
            claims.eat_nonce = nonce();
          },
        }),
      "nonce",
    ],
    [
      "an expired token",
      (n) =>
        bundle(n, {
          overall: (claims) => {
            const past = Math.floor(Date.now() / 1000) - 7200;
            Object.assign(claims, { iat: past, nbf: past, exp: past + 60 });
          },
        }),
      "time",
    ],
    [
      "a false overall result",
      (n) =>
        bundle(n, {
          overall: (claims) => {
            claims["x-nvidia-overall-att-result"] = false;
          },
        }),
      "result",
    ],
    [
      "debug enabled",
      (n) =>
        bundle(n, {
          gpu: (claims) => {
            claims.dbgstat = "enabled";
          },
        }),
      "result",
    ],
    [
      "secure boot off",
      (n) =>
        bundle(n, {
          gpu: (claims) => {
            claims.secboot = false;
          },
        }),
      "result",
    ],
    [
      "a failed measurement",
      (n) =>
        bundle(n, {
          gpu: (claims) => {
            claims.measres = "fail";
          },
        }),
      "result",
    ],
    [
      "a foreign issuer",
      (n) =>
        bundle(n, {
          overall: (claims) => {
            claims.iss = "https://evil.example";
          },
        }),
      "issuer",
    ],
    [
      "an attestation warning",
      (n) =>
        bundle(n, {
          gpu: (claims) => {
            claims["x-nvidia-attestation-warning"] = "RIM signer on hold";
          },
        }),
      "policy",
    ],
    [
      "a redirect",
      () => ({
        status: 302,
        headers: { location: "https://example.com/" },
        body: "",
      }),
      "transport",
    ],
    [
      "an oversized response",
      () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(["x".repeat(512 * 1024)]),
      }),
      "response",
    ],
  ])("rejects %s", async (_name, reply, reason) => {
    responder = ({ nonce: n }) => reply(n);
    const verifier = new NvidiaGpuAttestationVerifier(config());
    expect(
      await rejection(verifier.attest(nonce(), { evidence: EVIDENCE })),
    ).toBe(reason);
  });

  it("rejects a driver outside the pinned policy and a non-HTTPS NRAS URL", async () => {
    const pinned = new NvidiaGpuAttestationVerifier(
      config({ policy: { allowedDriverVersions: ["580.00"] } }),
    );
    expect(
      await rejection(pinned.attest(nonce(), { evidence: EVIDENCE })),
    ).toBe("policy");
    expect(
      () =>
        new NvidiaGpuAttestationVerifier(
          config({ nrasUrl: `http://127.0.0.1:1/v4/attest/gpu` }),
        ),
    ).toThrow(/configuration/);
  });
});
