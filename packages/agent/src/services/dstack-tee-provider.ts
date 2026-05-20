import { readFile } from "node:fs/promises";
import { normalizeTeeEvidence, type TeeEvidence } from "./tee-evidence.ts";

const DEFAULT_DSTACK_EVIDENCE_PATHS = [
  "/run/dstack/tee-evidence.json",
  "/var/run/dstack/tee-evidence.json",
];

export type DstackTeeProviderOptions = {
  endpointUrl?: string;
  evidencePath?: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
};

export type DstackTeeProvider = {
  id: "dstack";
  collectEvidence: () => Promise<TeeEvidence>;
};

export function createDstackTeeProvider(
  options: DstackTeeProviderOptions = {},
): DstackTeeProvider {
  return {
    id: "dstack",
    collectEvidence: async () => await collectDstackTeeEvidence(options),
  };
}

export async function collectDstackTeeEvidence(
  options: DstackTeeProviderOptions = {},
): Promise<TeeEvidence> {
  const env = options.env ?? process.env;
  const inline = env.ELIZA_TEE_EVIDENCE_JSON;
  if (inline?.trim()) {
    return normalizeDstackEvidence(JSON.parse(inline));
  }

  const endpointUrl =
    options.endpointUrl ?? env.ELIZA_TEE_EVIDENCE_URL ?? env.DSTACK_TAPPD_URL;
  if (endpointUrl?.trim()) {
    return await collectDstackEvidenceFromHttp(
      endpointUrl.trim(),
      options.fetch ?? fetch,
    );
  }

  const evidencePath =
    options.evidencePath ?? env.ELIZA_TEE_EVIDENCE_PATH ?? firstDefaultPath();
  if (evidencePath) {
    return normalizeDstackEvidence(
      JSON.parse(await readFile(evidencePath, "utf8")),
    );
  }

  throw new Error(
    "No dstack TEE evidence source configured. Set ELIZA_TEE_EVIDENCE_JSON, ELIZA_TEE_EVIDENCE_URL, or ELIZA_TEE_EVIDENCE_PATH.",
  );
}

async function collectDstackEvidenceFromHttp(
  endpointUrl: string,
  request: typeof fetch,
): Promise<TeeEvidence> {
  const response = await request(endpointUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to collect dstack TEE evidence: HTTP ${response.status}.`,
    );
  }
  return normalizeDstackEvidence(await response.json());
}

function normalizeDstackEvidence(value: unknown): TeeEvidence {
  const normalized = normalizeTeeEvidence(value);
  return {
    ...normalized,
    kind: normalized.kind === "dstack" ? "dstack" : normalized.kind,
    provider: normalized.provider ?? "dstack",
  };
}

function firstDefaultPath(): string | undefined {
  return DEFAULT_DSTACK_EVIDENCE_PATHS.find((path) => path.length > 0);
}
