/**
 * External-boundary double for NVIDIA's Remote Attestation Service: a local
 * HTTPS server (pinned self-signed TLS root) that serves an x5c-anchored P-384
 * JWKS and signs claims-3.0 detached EAT bundles for `/v4/attest/gpu`, plus a
 * SHA-256-pinned `nvattest collect-evidence` compatible collector script.
 * Mirrors the patterns of tee-gpu-nvidia-attestation.test.ts.
 */
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  type KeyObject,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const NRAS_ISSUER = "https://nras.attestation.nvidia.com";
export const GPU_FIRMWARE = {
  hwModel: "GH100 A01 GSP BROM",
  driver: "575.28",
  vbios: "96.00.AF.00.01",
};
const KID = "nv-eat-kid-emulator";

export type NrasRequest = { nonce: string; body: Record<string, unknown> };
export type NrasReply = { status: number; body: string };
export type NrasBehaviour = {
  /** Sign eat_nonce for a different nonce than the one submitted. */
  foreignNonce?: string;
  /** NRAS appraisal says the platform failed. */
  overallResultFalse?: boolean;
  /** NRAS refuses the request outright. */
  httpStatus?: number;
};

export type NrasEmulator = {
  origin: string;
  caPem: string;
  anchorSha256: string;
  behaviour: NrasBehaviour;
  requests: NrasRequest[];
  close(): Promise<void>;
};

function jwt(payload: Record<string, unknown>, key: KeyObject): string {
  const header = { alg: "ES384", kid: KID };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = sign("sha384", Buffer.from(input), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

function chain(): Record<string, unknown> {
  return {
    "x-nvidia-cert-status": "valid",
    "x-nvidia-cert-ocsp-status": "good",
  };
}

function gpuToken(nonce: string): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const flags = [
    "secboot",
    "x-nvidia-gpu-arch-check",
    "x-nvidia-gpu-attestation-report-parsed",
    "x-nvidia-gpu-attestation-report-nonce-match",
    "x-nvidia-gpu-attestation-report-signature-verified",
    "x-nvidia-gpu-attestation-report-cert-chain-fwid-match",
    "x-nvidia-gpu-driver-rim-fetched",
    "x-nvidia-gpu-driver-rim-schema-validated",
    "x-nvidia-gpu-driver-rim-signature-verified",
    "x-nvidia-gpu-driver-rim-version-match",
    "x-nvidia-gpu-driver-rim-measurements-available",
    "x-nvidia-gpu-vbios-rim-fetched",
    "x-nvidia-gpu-vbios-rim-schema-validated",
    "x-nvidia-gpu-vbios-rim-signature-verified",
    "x-nvidia-gpu-vbios-rim-version-match",
    "x-nvidia-gpu-vbios-rim-measurements-available",
    "x-nvidia-gpu-vbios-index-no-conflict",
  ];
  return {
    iss: NRAS_ISSUER,
    iat: now,
    nbf: now - 5,
    exp: now + 3600,
    eat_nonce: nonce,
    measres: "success",
    dbgstat: "disabled",
    hwmodel: GPU_FIRMWARE.hwModel,
    ueid: "490457405999046854973671575630853621547794591064",
    "x-nvidia-gpu-driver-version": GPU_FIRMWARE.driver,
    "x-nvidia-gpu-vbios-version": GPU_FIRMWARE.vbios,
    ...Object.fromEntries(flags.map((flag) => [flag, true])),
    "x-nvidia-gpu-attestation-report-cert-chain": chain(),
    "x-nvidia-gpu-driver-rim-cert-chain": chain(),
    "x-nvidia-gpu-vbios-rim-cert-chain": chain(),
  };
}

export async function startNrasEmulator(dir: string): Promise<NrasEmulator> {
  const openssl = (args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  const ec = (curve: string) => [
    "-newkey",
    "ec",
    "-pkeyopt",
    `ec_paramgen_curve:${curve}`,
    "-nodes",
  ];
  openssl([
    "req",
    "-x509",
    ...ec("P-256"),
    "-keyout",
    "nras-tls-key.pem",
    "-out",
    "nras-tls-cert.pem",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  openssl([
    "req",
    "-x509",
    ...ec("P-384"),
    "-keyout",
    "nras-ca-key.pem",
    "-out",
    "nras-ca-cert.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Test NRAS GPU Intermediate",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  openssl([
    "req",
    "-new",
    ...ec("P-384"),
    "-keyout",
    "nras-leaf-key.pem",
    "-out",
    "nras-leaf.csr",
    "-subj",
    "/CN=Test NRAS GPU Signer",
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    "nras-leaf.csr",
    "-CA",
    "nras-ca-cert.pem",
    "-CAkey",
    "nras-ca-key.pem",
    "-CAcreateserial",
    "-out",
    "nras-leaf-cert.pem",
    "-days",
    "1",
  ]);
  const read = (name: string) => readFile(path.join(dir, name), "utf8");
  const caPem = await read("nras-tls-cert.pem");
  const signingKey = createPrivateKey(await read("nras-leaf-key.pem"));
  const leaf = new X509Certificate(await read("nras-leaf-cert.pem"));
  const ca = new X509Certificate(await read("nras-ca-cert.pem"));
  const jwks = JSON.stringify({
    keys: [
      {
        ...leaf.publicKey.export({ format: "jwk" }),
        kid: KID,
        alg: "ES384",
        use: "sig",
        x5c: [leaf.raw.toString("base64"), ca.raw.toString("base64")],
      },
    ],
  });
  const behaviour: NrasBehaviour = {};
  const requests: NrasRequest[] = [];

  const server: Server = createServer(
    { key: await read("nras-tls-key.pem"), cert: caPem },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.method === "GET" && req.url === "/.well-known/jwks.json") {
          res.writeHead(200, { "content-type": "application/json" }).end(jwks);
          return;
        }
        if (req.method !== "POST" || req.url !== "/v4/attest/gpu") {
          res.writeHead(404).end();
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const nonce = String(body.nonce);
        requests.push({ nonce, body });
        if (behaviour.httpStatus) {
          res.writeHead(behaviour.httpStatus).end("{}");
          return;
        }
        const signed = behaviour.foreignNonce ?? nonce;
        const now = Math.floor(Date.now() / 1000);
        const overall = {
          iss: NRAS_ISSUER,
          iat: now,
          nbf: now - 5,
          exp: now + 3600,
          "x-nvidia-ver": "3.0",
          "x-nvidia-overall-att-result": !behaviour.overallResultFalse,
          eat_nonce: signed,
          submods: { "GPU-0": ["DIGEST", ["SHA-256", "ab".repeat(32)]] },
        };
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(
            JSON.stringify([
              ["JWT", jwt(overall, signingKey)],
              { "GPU-0": jwt(gpuToken(signed), signingKey) },
            ]),
          );
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    caPem,
    anchorSha256: createHash("sha256").update(ca.raw).digest("hex"),
    behaviour,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * `nvattest collect-evidence --device gpu --nonce <hex> --format json`
 * compatible collector. `boundNonce` fixes the nonce it reports.
 */
export async function writePinnedCollector(
  dir: string,
  name: string,
  boundNonce?: string,
): Promise<{ path: string; sha256: string }> {
  const collectorPath = path.join(dir, name);
  const nonce = boundNonce ?? '"$5"';
  await writeFile(
    collectorPath,
    `#!/bin/sh\nprintf '{"evidences":[{"arch":"Hopper","nonce":"%s","evidence":"ZXZpZGVuY2U=","certificate":"Y2VydA=="}],"result_code":0,"result_message":"Ok"}' ${boundNonce ? `"${nonce}"` : nonce}\n`,
  );
  await chmod(collectorPath, 0o755);
  return {
    path: collectorPath,
    sha256: createHash("sha256")
      .update(await readFile(collectorPath))
      .digest("hex"),
  };
}
