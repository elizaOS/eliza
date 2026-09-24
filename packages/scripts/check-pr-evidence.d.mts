/** Types the evidence verifier boundary consumed by the leaderboard generator. */

export interface ArtifactVerificationFinding {
  id: string;
  label: string;
  url: string;
  artifactKind?: string;
  status: string;
  detail?: string;
  contentSha256?: string | null;
}

export interface ArtifactVerificationResult {
  ok: boolean;
  findings: ArtifactVerificationFinding[];
}

export function extractEvidenceRows(body: string): Map<string, string>;

export function planReferencedArtifacts(
  body: string,
  requiredRows: ReadonlyArray<{ id: string; label: string }>,
  options?: { allowedArtifactKinds?: string[] },
): { referenceCount: number; uniqueArtifactCount: number };

export function verifyReferencedArtifacts(
  body: string,
  requiredRows: ReadonlyArray<{ id: string; label: string }>,
  options?: {
    concurrency?: number;
    allowedArtifactKinds?: string[];
    contentDigestLimitBytes?: number;
    fetchImpl?: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Promise<Response>;
    timeoutMs?: number;
    token?: string;
  },
): Promise<ArtifactVerificationResult>;
