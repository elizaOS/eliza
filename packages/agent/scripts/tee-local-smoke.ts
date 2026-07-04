import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { collectDstackTeeEvidence } from "../../../plugins/plugin-tee/src/confidential/dstack-tee-provider.ts";
import type { TeeEvidence } from "../src/services/tee-evidence.ts";
import {
  HttpTeeKeyReleaseClient,
  LocalTeeKeyReleaseClient,
  wrapTeeReleaseKey,
} from "../src/services/tee-key-release.ts";
import { evaluateTeeEvidencePolicy } from "../src/services/tee-policy.ts";

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const nonce = "local-tee-smoke-nonce";
const now = "2026-05-20T00:00:00.000Z";
const evidence = {
  kind: "dstack",
  provider: "dstack",
  hardwareVendor: "mock-macos",
  platformVersion: "local-smoke",
  securityVersion: 1,
  measurements: {
    boot: digest("a"),
    os: digest("b"),
    agent: digest("c"),
    policy: digest("d"),
    container: digest("e"),
  },
  freshness: {
    nonce,
    timestamp: now,
    verifier: "local-smoke",
  },
  claims: {
    debugDisabled: true,
    productionLifecycle: true,
    secureBoot: true,
    memoryEncrypted: true,
    ioProtected: true,
  },
};

const server = createServer((request, response) => {
  if (request.url !== "/evidence") {
    if (request.url === "/v1/tee/key-release" && request.method === "POST") {
      void handleKeyReleaseRequest(request, response);
      return;
    }
    response.writeHead(404);
    response.end("not found");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(evidence));
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("Local TEE smoke server did not bind to a TCP port.");
}

try {
  const endpointUrl = `http://127.0.0.1:${address.port}/evidence`;
  const collected = await collectDstackTeeEvidence({
    endpointUrl,
    env: {},
  });
  const accepted = evaluateTeeEvidencePolicy(collected, {
    required: true,
    allowedKinds: ["dstack"],
    allowedProviders: ["dstack"],
    minSecurityVersion: 1,
    expectedNonce: nonce,
    maxAgeMs: 60_000,
    nowMs: Date.parse(now),
    requiredMeasurements: {
      boot: digest("a"),
      os: digest("b"),
      agent: digest("c"),
      policy: digest("d"),
    },
    requiredClaims: {
      debugDisabled: true,
      productionLifecycle: true,
      secureBoot: true,
      memoryEncrypted: true,
      ioProtected: true,
    },
  });
  const rejected = evaluateTeeEvidencePolicy(collected, {
    required: true,
    requiredMeasurements: {
      agent: digest("f"),
    },
  });
  const keyRelease = await new LocalTeeKeyReleaseClient({
    masterSecretHex: "22".repeat(32),
    evidenceProvider: {
      id: "local-smoke",
      collectEvidence: async () => collected,
    },
  }).releaseKey({
    keyId: "local-agent-session",
    context: "tee-local-smoke",
    policy: {
      required: true,
      allowedKinds: ["dstack"],
      expectedNonce: nonce,
      requiredMeasurements: {
        agent: digest("c"),
        policy: digest("d"),
      },
      requiredClaims: {
        debugDisabled: true,
        secureBoot: true,
      },
    },
  });
  const httpKeyRelease = await new HttpTeeKeyReleaseClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    evidenceProvider: {
      id: "local-smoke",
      collectEvidence: async () => collected,
    },
  }).releaseKey({
    keyId: "remote-agent-session",
    context: "tee-local-smoke-http",
    policy: {
      required: true,
      allowedKinds: ["dstack"],
      expectedNonce: nonce,
      requiredMeasurements: {
        agent: digest("c"),
        policy: digest("d"),
      },
      requiredClaims: {
        debugDisabled: true,
        secureBoot: true,
      },
    },
  });

  const result = {
    ok:
      accepted.trusted === true &&
      rejected.trusted === false &&
      /^[a-f0-9]{64}$/.test(keyRelease.keyMaterialHex) &&
      /^[a-f0-9]{64}$/.test(httpKeyRelease.keyMaterialHex),
    endpoint: "local-http-evidence-endpoint",
    accepted: summarizeDecision(accepted),
    rejected: summarizeDecision(rejected),
    keyRelease: {
      keyId: keyRelease.keyId,
      keyMaterialSha256: createHash("sha256")
        .update(keyRelease.keyMaterialHex, "utf8")
        .digest("hex"),
      decision: summarizeDecision(keyRelease.decision),
    },
    httpKeyRelease: {
      keyId: httpKeyRelease.keyId,
      keyMaterialSha256: createHash("sha256")
        .update(httpKeyRelease.keyMaterialHex, "utf8")
        .digest("hex"),
      decision: summarizeDecision(httpKeyRelease.decision),
    },
  };
  if (!result.ok) {
    throw new Error(`TEE local smoke failed: ${JSON.stringify(result)}`);
  }
  const outputPath = path.resolve(
    "evidence/tee/local-tee-smoke-2026-05-20.json",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`TEE local smoke passed: ${outputPath}`);
} finally {
  server.close();
}

async function handleKeyReleaseRequest(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const body = await readRequestBody(request);
  const payload = JSON.parse(body) as {
    keyId: string;
    context?: string;
    nonce: string;
    ephemeralPublicKey: string;
    policy: Parameters<typeof evaluateTeeEvidencePolicy>[1];
    evidence: TeeEvidence;
  };
  const decision = evaluateTeeEvidencePolicy(payload.evidence, payload.policy);
  if (!decision.trusted) {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ decision }));
    return;
  }
  const keyMaterialHex = createHash("sha256")
    .update("mock-http-kms\n", "utf8")
    .update(payload.keyId, "utf8")
    .update(payload.context ?? "", "utf8")
    .update(payload.evidence.measurements?.agent ?? "", "utf8")
    .update(payload.evidence.measurements?.policy ?? "", "utf8")
    .digest("hex");
  // Wrap the released key to the agent's ephemeral public key so the client's
  // X25519/HKDF/AES-256-GCM unwrap succeeds (plan §3.2 step 5).
  const wrappedKey = wrapTeeReleaseKey({
    keyMaterialHex,
    agentEphemeralPublicKeyDerBase64: payload.ephemeralPublicKey,
    nonceHex: payload.nonce,
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      keyId: payload.keyId,
      wrappedKey,
      // Echo the client-issued nonce for the replay-binding check.
      nonce: payload.nonce,
      decision,
    }),
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function summarizeDecision(decision: {
  trusted: boolean;
  reason: string;
  detail?: string;
  evidence?: TeeEvidence;
}) {
  return {
    trusted: decision.trusted,
    reason: decision.reason,
    ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    ...(decision.evidence === undefined
      ? {}
      : {
          evidence: {
            kind: decision.evidence.kind,
            provider: decision.evidence.provider,
            hardwareVendor: decision.evidence.hardwareVendor,
            platformVersion: decision.evidence.platformVersion,
            securityVersion: decision.evidence.securityVersion,
            measurements: decision.evidence.measurements,
            freshness: decision.evidence.freshness,
            claims: decision.evidence.claims,
          },
        }),
  };
}
