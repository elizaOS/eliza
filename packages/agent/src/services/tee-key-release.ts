import { createHmac, randomBytes } from "node:crypto";
import type { TeeEvidenceProvider } from "./tee-evidence.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "./tee-policy.ts";

export type TeeKeyReleaseRequest = {
  keyId: string;
  context?: string;
  policy: TeeEvidencePolicy;
};

export type TeeKeyReleaseResult = {
  keyId: string;
  keyMaterialHex: string;
  decision: TeeEvidencePolicyDecision;
};

export type TeeKeyReleaseClient = {
  releaseKey: (request: TeeKeyReleaseRequest) => Promise<TeeKeyReleaseResult>;
};

export type LocalTeeKeyReleaseClientConfig = {
  evidenceProvider: TeeEvidenceProvider;
  masterSecretHex?: string;
  onDecision?: (decision: TeeEvidencePolicyDecision) => void;
};

export type HttpTeeKeyReleaseClientConfig = {
  baseUrl: string;
  evidenceProvider: TeeEvidenceProvider;
  fetch?: typeof fetch;
  token?: string;
  onDecision?: (decision: TeeEvidencePolicyDecision) => void;
};

export class LocalTeeKeyReleaseClient implements TeeKeyReleaseClient {
  private readonly masterSecret: Buffer;

  constructor(private readonly config: LocalTeeKeyReleaseClientConfig) {
    this.masterSecret = config.masterSecretHex
      ? Buffer.from(config.masterSecretHex, "hex")
      : randomBytes(32);
    if (this.masterSecret.length < 32) {
      throw new Error(
        "TEE key-release master secret must be at least 32 bytes.",
      );
    }
  }

  async releaseKey(
    request: TeeKeyReleaseRequest,
  ): Promise<TeeKeyReleaseResult> {
    const evidence = await this.config.evidenceProvider.collectEvidence();
    const decision = evaluateTeeEvidencePolicy(evidence, request.policy);
    this.config.onDecision?.(decision);
    if (!decision.trusted || !decision.evidence) {
      throw new Error(
        `TEE key release rejected evidence: ${decision.detail ?? decision.reason}`,
      );
    }
    return {
      keyId: request.keyId,
      keyMaterialHex: deriveKeyMaterial({
        masterSecret: this.masterSecret,
        keyId: request.keyId,
        context: request.context,
        agentMeasurement: decision.evidence.measurements?.agent,
        policyMeasurement: decision.evidence.measurements?.policy,
        deviceMeasurement: decision.evidence.measurements?.device,
      }),
      decision,
    };
  }
}

export class HttpTeeKeyReleaseClient implements TeeKeyReleaseClient {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;

  constructor(private readonly config: HttpTeeKeyReleaseClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.request = config.fetch ?? fetch;
  }

  async releaseKey(
    request: TeeKeyReleaseRequest,
  ): Promise<TeeKeyReleaseResult> {
    const evidence = await this.config.evidenceProvider.collectEvidence();
    const response = await this.request(
      new URL("/v1/tee/key-release", this.baseUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.config.token === undefined
            ? {}
            : { authorization: `Bearer ${this.config.token}` }),
        },
        body: JSON.stringify({
          keyId: request.keyId,
          context: request.context,
          policy: request.policy,
          evidence,
        }),
      },
    );
    const payload = await readJsonResponse(response);
    const decision = payload.decision;
    if (decision) {
      this.config.onDecision?.(decision);
    }
    if (!response.ok || !decision?.trusted) {
      throw new Error(
        `TEE key release rejected evidence: ${
          decision?.detail ?? decision?.reason ?? response.status
        }`,
      );
    }
    if (
      typeof payload.keyId !== "string" ||
      payload.keyId !== request.keyId ||
      typeof payload.keyMaterialHex !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.keyMaterialHex)
    ) {
      throw new Error("TEE key release response is malformed.");
    }
    return {
      keyId: payload.keyId,
      keyMaterialHex: payload.keyMaterialHex,
      decision,
    };
  }
}

function deriveKeyMaterial(options: {
  masterSecret: Buffer;
  keyId: string;
  context?: string;
  agentMeasurement?: string;
  policyMeasurement?: string;
  deviceMeasurement?: string;
}): string {
  return createHmac("sha256", options.masterSecret)
    .update(`key:${options.keyId}\n`)
    .update(`context:${options.context ?? ""}\n`)
    .update(`agent:${options.agentMeasurement ?? ""}\n`)
    .update(`policy:${options.policyMeasurement ?? ""}\n`)
    .update(`device:${options.deviceMeasurement ?? ""}\n`)
    .digest("hex");
}

async function readJsonResponse(response: Response): Promise<{
  keyId?: unknown;
  keyMaterialHex?: unknown;
  decision?: TeeEvidencePolicyDecision;
}> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as {
      keyId?: unknown;
      keyMaterialHex?: unknown;
      decision?: TeeEvidencePolicyDecision;
    };
  } catch {
    throw new Error("TEE key release response is not valid JSON.");
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TEE key release baseUrl must be http(s).");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}
