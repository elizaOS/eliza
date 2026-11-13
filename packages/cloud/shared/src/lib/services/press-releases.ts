/**
 * PR / press distribution domain service (#11818).
 *
 * Owns Cloud's press-release lifecycle before any external newswire provider is
 * selected. Provider integrations attach distribution attempts to this service
 * in later slices; until then the state machine fails closed instead of
 * pretending a release was distributed.
 */

import {
  type NewPressRelease,
  type PressCoverage,
  type PressMediaContact,
  type PressRelease,
  type PressReleaseAsset,
  type PressReleaseDistribution,
  type PressReleaseTargetAudience,
  pressReleasesRepository,
} from "../../db/repositories/press-releases";

export interface PressReleaseResult {
  ok: boolean;
  release?: PressRelease;
  distribution?: PressReleaseDistribution;
  error?: string;
}

export interface PressDistributionResult {
  ok: boolean;
  release?: PressRelease;
  distribution?: PressReleaseDistribution;
  error?: string;
}

function cleanText(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function validateEmbargo(embargoAt?: Date | null): string | undefined {
  if (!embargoAt) return undefined;
  if (Number.isNaN(embargoAt.getTime())) return "Embargo timestamp is invalid";
  if (embargoAt.getTime() <= Date.now()) return "Embargo must be in the future";
  return undefined;
}

function validateAssets(assets: PressReleaseAsset[] | undefined): string | undefined {
  for (const asset of assets ?? []) {
    const url = cleanText(asset.url);
    if (!url) return "Asset URL is required";
    try {
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol)) return "Asset URL must be HTTP(S)";
    } catch {
      return "Asset URL is invalid";
    }
  }
  return undefined;
}

export class PressReleaseService {
  async createRelease(input: {
    organizationId: string;
    userId: string;
    title: string;
    body: string;
    summary?: string;
    boilerplate?: string;
    targetAudience?: PressReleaseTargetAudience;
    targetRegions?: string[];
    assets?: PressReleaseAsset[];
    embargoAt?: Date | null;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PressReleaseResult> {
    const title = cleanText(input.title);
    const body = cleanText(input.body);
    if (!title) return { ok: false, error: "Title is required" };
    if (!body) return { ok: false, error: "Body is required" };
    const embargoError = validateEmbargo(input.embargoAt);
    if (embargoError) return { ok: false, error: embargoError };
    const assetError = validateAssets(input.assets);
    if (assetError) return { ok: false, error: assetError };

    if (input.idempotencyKey) {
      const existing = await pressReleasesRepository.findReleaseByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.organization_id !== input.organizationId) {
          return { ok: false, error: "Idempotency key already used" };
        }
        return { ok: true, release: existing };
      }
    }

    const release = await pressReleasesRepository.createRelease({
      organization_id: input.organizationId,
      created_by_user_id: input.userId,
      title,
      body,
      summary: cleanText(input.summary) || null,
      boilerplate: cleanText(input.boilerplate) || null,
      target_audience: input.targetAudience ?? {},
      target_regions: normalizeStringList(input.targetRegions),
      assets: input.assets ?? [],
      embargo_at: input.embargoAt ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      metadata: input.metadata ?? {},
    });
    return { ok: true, release };
  }

  getRelease(id: string, organizationId: string): Promise<PressRelease | undefined> {
    return pressReleasesRepository.findReleaseByIdForOrg(id, organizationId);
  }

  listReleases(organizationId: string): Promise<PressRelease[]> {
    return pressReleasesRepository.listReleasesForOrg(organizationId);
  }

  async updateDraft(
    id: string,
    organizationId: string,
    patch: {
      title?: string;
      body?: string;
      summary?: string | null;
      boilerplate?: string | null;
      targetAudience?: PressReleaseTargetAudience;
      targetRegions?: string[];
      assets?: PressReleaseAsset[];
      embargoAt?: Date | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<PressReleaseResult> {
    const set: Partial<NewPressRelease> = {};
    if (patch.title !== undefined) {
      const title = cleanText(patch.title);
      if (!title) return { ok: false, error: "Title is required" };
      set.title = title;
    }
    if (patch.body !== undefined) {
      const body = cleanText(patch.body);
      if (!body) return { ok: false, error: "Body is required" };
      set.body = body;
    }
    if (patch.summary !== undefined) set.summary = cleanText(patch.summary) || null;
    if (patch.boilerplate !== undefined) set.boilerplate = cleanText(patch.boilerplate) || null;
    if (patch.targetAudience !== undefined) set.target_audience = patch.targetAudience;
    if (patch.targetRegions !== undefined) {
      set.target_regions = normalizeStringList(patch.targetRegions);
    }
    if (patch.assets !== undefined) {
      const assetError = validateAssets(patch.assets);
      if (assetError) return { ok: false, error: assetError };
      set.assets = patch.assets;
    }
    if (patch.embargoAt !== undefined) {
      const embargoError = validateEmbargo(patch.embargoAt);
      if (embargoError) return { ok: false, error: embargoError };
      set.embargo_at = patch.embargoAt;
    }
    if (patch.metadata !== undefined) set.metadata = patch.metadata;

    const release = await pressReleasesRepository.updateReleaseDraft(id, organizationId, set);
    return release ? { ok: true, release } : { ok: false, error: "Draft press release not found" };
  }

  async markReady(id: string, organizationId: string): Promise<PressReleaseResult> {
    const release = await this.getRelease(id, organizationId);
    if (!release) return { ok: false, error: "Press release not found" };
    if (release.status === "ready") return { ok: true, release };
    if (release.status !== "draft") return { ok: false, error: "Press release is not editable" };
    if (!cleanText(release.title) || !cleanText(release.body)) {
      return { ok: false, error: "Title and body are required" };
    }
    const moved = await pressReleasesRepository.transitionRelease(
      id,
      organizationId,
      "draft",
      "ready",
    );
    return moved
      ? { ok: true, release: moved }
      : { ok: false, error: "Press release changed state" };
  }

  async recordSubmission(input: {
    releaseId: string;
    organizationId: string;
    provider: string;
    requestPayload?: Record<string, unknown>;
    externalDistributionId?: string;
    providerResponse?: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<PressDistributionResult> {
    const provider = cleanText(input.provider);
    if (!provider) return { ok: false, error: "Provider is required" };

    if (input.idempotencyKey) {
      const existing = await pressReleasesRepository.findDistributionByIdempotencyKey(
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.organization_id !== input.organizationId) {
          return { ok: false, error: "Idempotency key already used" };
        }
        const release = await this.getRelease(existing.press_release_id, input.organizationId);
        return { ok: true, release, distribution: existing };
      }
    }

    const release = await this.getRelease(input.releaseId, input.organizationId);
    if (!release) return { ok: false, error: "Press release not found" };
    if (!["ready", "submitted"].includes(release.status)) {
      return { ok: false, error: "Press release is not ready for submission" };
    }

    const distribution = await pressReleasesRepository.createDistribution({
      organization_id: input.organizationId,
      press_release_id: input.releaseId,
      provider,
      external_distribution_id: input.externalDistributionId ?? null,
      status: "submitted",
      idempotency_key: input.idempotencyKey ?? null,
      request_payload: input.requestPayload ?? {},
      provider_response: input.providerResponse ?? {},
      submitted_at: new Date(),
    });

    const submittedRelease =
      release.status === "submitted"
        ? release
        : await pressReleasesRepository.transitionRelease(
            input.releaseId,
            input.organizationId,
            "ready",
            "submitted",
            {
              submitted_at: new Date(),
            },
          );
    return submittedRelease
      ? { ok: true, release: submittedRelease, distribution }
      : { ok: false, error: "Submission could not be finalized" };
  }

  async markDistributed(input: {
    distributionId: string;
    organizationId: string;
    providerResponse?: Record<string, unknown>;
  }): Promise<PressDistributionResult> {
    const distribution = await pressReleasesRepository.findDistributionById(input.distributionId);
    if (!distribution || distribution.organization_id !== input.organizationId) {
      return { ok: false, error: "Distribution not found" };
    }
    const movedDistribution =
      distribution.status === "distributed"
        ? distribution
        : await pressReleasesRepository.transitionDistribution(
            distribution.id,
            "submitted",
            "distributed",
            {
              provider_response: input.providerResponse ?? distribution.provider_response,
              completed_at: new Date(),
            },
          );
    if (!movedDistribution) return { ok: false, error: "Distribution is not submitted" };

    const release =
      (await pressReleasesRepository.transitionRelease(
        distribution.press_release_id,
        input.organizationId,
        "submitted",
        "distributed",
        { distributed_at: new Date() },
      )) ?? (await this.getRelease(distribution.press_release_id, input.organizationId));
    return { ok: true, release, distribution: movedDistribution };
  }

  async markFailed(input: {
    distributionId: string;
    organizationId: string;
    error: string;
    providerResponse?: Record<string, unknown>;
  }): Promise<PressDistributionResult> {
    const distribution = await pressReleasesRepository.findDistributionById(input.distributionId);
    if (!distribution || distribution.organization_id !== input.organizationId) {
      return { ok: false, error: "Distribution not found" };
    }
    const movedDistribution =
      distribution.status === "failed"
        ? distribution
        : await pressReleasesRepository.transitionDistribution(
            distribution.id,
            "submitted",
            "failed",
            {
              error_message: cleanText(input.error) || "Distribution failed",
              provider_response: input.providerResponse ?? distribution.provider_response,
              completed_at: new Date(),
            },
          );
    if (!movedDistribution) return { ok: false, error: "Distribution is not submitted" };

    const release =
      (await pressReleasesRepository.transitionRelease(
        distribution.press_release_id,
        input.organizationId,
        "submitted",
        "failed",
        { failed_reason: movedDistribution.error_message ?? "Distribution failed" },
      )) ?? (await this.getRelease(distribution.press_release_id, input.organizationId));
    return { ok: true, release, distribution: movedDistribution };
  }

  async cancelRelease(id: string, organizationId: string): Promise<PressReleaseResult> {
    const release = await this.getRelease(id, organizationId);
    if (!release) return { ok: false, error: "Press release not found" };
    if (release.status === "cancelled") return { ok: true, release };
    if (!["draft", "ready"].includes(release.status)) {
      return { ok: false, error: "Submitted press releases cannot be cancelled here" };
    }
    const moved =
      (await pressReleasesRepository.transitionRelease(id, organizationId, "draft", "cancelled")) ??
      (await pressReleasesRepository.transitionRelease(id, organizationId, "ready", "cancelled"));
    return moved
      ? { ok: true, release: moved }
      : { ok: false, error: "Press release changed state" };
  }

  createContact(input: {
    organizationId: string;
    userId?: string;
    name: string;
    outlet: string;
    email?: string;
    beat?: string;
    region?: string;
    metadata?: Record<string, unknown>;
  }): Promise<PressMediaContact> {
    const name = cleanText(input.name);
    const outlet = cleanText(input.outlet);
    if (!name || !outlet) {
      throw new Error("Contact name and outlet are required");
    }
    return pressReleasesRepository.createContact({
      organization_id: input.organizationId,
      created_by_user_id: input.userId ?? null,
      name,
      outlet,
      email: cleanText(input.email) || null,
      beat: cleanText(input.beat) || null,
      region: cleanText(input.region) || null,
      metadata: input.metadata ?? {},
    });
  }

  listContacts(organizationId: string): Promise<PressMediaContact[]> {
    return pressReleasesRepository.listContactsForOrg(organizationId);
  }

  async recordCoverage(input: {
    organizationId: string;
    releaseId: string;
    distributionId?: string;
    url: string;
    title?: string;
    outlet?: string;
    publishedAt?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<PressCoverage> {
    const release = await this.getRelease(input.releaseId, input.organizationId);
    if (!release) throw new Error("Press release not found");
    return pressReleasesRepository.recordCoverage({
      organization_id: input.organizationId,
      press_release_id: input.releaseId,
      distribution_id: input.distributionId ?? null,
      url: input.url,
      title: cleanText(input.title) || null,
      outlet: cleanText(input.outlet) || null,
      published_at: input.publishedAt ?? null,
      metadata: input.metadata ?? {},
    });
  }

  listCoverage(releaseId: string, organizationId: string): Promise<PressCoverage[]> {
    return pressReleasesRepository.listCoverageForRelease(releaseId, organizationId);
  }
}

export const pressReleaseService = new PressReleaseService();
