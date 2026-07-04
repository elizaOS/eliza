/**
 * Marketing PR route coverage (#11819).
 *
 * Drives the real Hono route modules and the #11818 press-release service.
 * Auth and the repository boundary are faked so the API package test stays
 * self-contained while still proving route validation, tenant scoping, and
 * fail-closed submit behavior through the service lifecycle.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

type NewPressCoverage =
  import("@/db/repositories/press-releases").NewPressCoverage;
type NewPressRelease =
  import("@/db/repositories/press-releases").NewPressRelease;
type PressCoverage = import("@/db/repositories/press-releases").PressCoverage;
type PressRelease = import("@/db/repositories/press-releases").PressRelease;
type PressReleaseDistribution =
  import("@/db/repositories/press-releases").PressReleaseDistribution;
type PressReleaseStatus =
  import("@/db/schemas/press-releases").PressReleaseStatus;

interface CurrentUser {
  id: string;
  organization_id: string;
}

let currentUser: CurrentUser = {
  id: "user_default",
  organization_id: "org_default",
};

const requireUserOrApiKeyWithOrg = mock(async () => currentUser);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

const releases: PressRelease[] = [];
const coverageRows: PressCoverage[] = [];
let seq = 0;

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq}`;
}

function isoDate(offsetMs = 0): Date {
  return new Date(Date.UTC(2026, 6, 3, 12, 0, 0, 0) + offsetMs);
}

function releaseDefaults(data: NewPressRelease): PressRelease {
  const now = isoDate(seq);
  return {
    id: uniq("release"),
    organization_id: data.organization_id,
    created_by_user_id: data.created_by_user_id ?? null,
    title: data.title,
    summary: data.summary ?? null,
    body: data.body,
    boilerplate: data.boilerplate ?? null,
    status: (data.status ?? "draft") as PressReleaseStatus,
    target_audience: data.target_audience ?? {},
    target_regions: data.target_regions ?? [],
    assets: data.assets ?? [],
    embargo_at: data.embargo_at ?? null,
    submitted_at: data.submitted_at ?? null,
    distributed_at: data.distributed_at ?? null,
    failed_reason: data.failed_reason ?? null,
    idempotency_key: data.idempotency_key ?? null,
    metadata: data.metadata ?? {},
    created_at: data.created_at ?? now,
    updated_at: data.updated_at ?? now,
  };
}

const pressReleasesRepository = {
  findReleaseByIdempotencyKey: mock(
    async (key: string): Promise<PressRelease | undefined> =>
      releases.find((release) => release.idempotency_key === key),
  ),
  createRelease: mock(async (data: NewPressRelease): Promise<PressRelease> => {
    const release = releaseDefaults(data);
    releases.push(release);
    return release;
  }),
  findReleaseByIdForOrg: mock(
    async (
      id: string,
      organizationId: string,
    ): Promise<PressRelease | undefined> =>
      releases.find(
        (release) =>
          release.id === id && release.organization_id === organizationId,
      ),
  ),
  listReleasesForOrg: mock(
    async (organizationId: string): Promise<PressRelease[]> =>
      releases.filter((release) => release.organization_id === organizationId),
  ),
  updateReleaseDraft: mock(
    async (
      id: string,
      organizationId: string,
      data: Partial<NewPressRelease>,
    ): Promise<PressRelease | undefined> => {
      const index = releases.findIndex(
        (release) =>
          release.id === id &&
          release.organization_id === organizationId &&
          release.status === "draft",
      );
      if (index < 0) return undefined;
      releases[index] = {
        ...releases[index],
        ...data,
        updated_at: isoDate(seq),
      };
      return releases[index];
    },
  ),
  transitionRelease: mock(
    async (
      id: string,
      organizationId: string,
      from: PressReleaseStatus,
      to: PressReleaseStatus,
      extra: Partial<NewPressRelease> = {},
    ): Promise<PressRelease | undefined> => {
      const index = releases.findIndex(
        (release) =>
          release.id === id &&
          release.organization_id === organizationId &&
          release.status === from,
      );
      if (index < 0) return undefined;
      releases[index] = {
        ...releases[index],
        ...extra,
        status: to,
        updated_at: isoDate(seq),
      };
      return releases[index];
    },
  ),
  findDistributionByIdempotencyKey: mock(
    async (): Promise<PressReleaseDistribution | undefined> => undefined,
  ),
  listCoverageForRelease: mock(
    async (
      pressReleaseId: string,
      organizationId: string,
    ): Promise<PressCoverage[]> =>
      coverageRows.filter(
        (coverage) =>
          coverage.press_release_id === pressReleaseId &&
          coverage.organization_id === organizationId,
      ),
  ),
  recordCoverage: mock(
    async (data: NewPressCoverage): Promise<PressCoverage> => {
      const existing = coverageRows.find(
        (coverage) =>
          coverage.press_release_id === data.press_release_id &&
          coverage.url === data.url,
      );
      if (existing) {
        Object.assign(existing, {
          title: data.title ?? null,
          outlet: data.outlet ?? null,
          published_at: data.published_at ?? null,
          metadata: data.metadata ?? {},
        });
        return existing;
      }
      const row: PressCoverage = {
        id: uniq("coverage"),
        organization_id: data.organization_id,
        press_release_id: data.press_release_id,
        distribution_id: data.distribution_id ?? null,
        url: data.url,
        title: data.title ?? null,
        outlet: data.outlet ?? null,
        published_at: data.published_at ?? null,
        metadata: data.metadata ?? {},
        created_at: isoDate(seq),
      };
      coverageRows.push(row);
      return row;
    },
  ),
};

mock.module("../../../../shared/src/db/repositories/press-releases", () => ({
  pressReleasesRepository,
}));

let api: Hono;
let pressReleaseService: typeof import("@/lib/services/press-releases").pressReleaseService;

function actor(label: string) {
  return { orgId: `org_${label}`, userId: `user_${label}` };
}

function actAs(user: { orgId: string; userId: string }): void {
  currentUser = { id: user.userId, organization_id: user.orgId };
}

async function fetchApi(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return api.fetch(
    new Request(`https://api.example.test${path}`, {
      ...init,
      headers,
    }),
  );
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function createDraft(
  owner: { orgId: string; userId: string },
  title = "Eliza Cloud launches PR routes",
): Promise<PressRelease> {
  actAs(owner);
  const response = await fetchApi("/api/v1/marketing/pr", {
    method: "POST",
    body: JSON.stringify({
      title,
      body: "Eliza Cloud now exposes press release draft routes.",
      targetRegions: ["US", "EU"],
      assets: [
        {
          url: "https://example.test/press-kit.png",
          mimeType: "image/png",
        },
      ],
      idempotencyKey: uniq("release-key"),
    }),
  });
  expect(response.status).toBe(201);
  const json = await responseJson<{ release: PressRelease }>(response);
  return json.release;
}

beforeAll(async () => {
  ({ pressReleaseService } = await import("@/lib/services/press-releases"));

  const [
    { default: rootRoute },
    { default: detailRoute },
    { default: submitRoute },
    { default: cancelRoute },
    { default: coverageRoute },
  ] = await Promise.all([
    import("./route"),
    import("./[releaseId]/route"),
    import("./[releaseId]/submit/route"),
    import("./[releaseId]/cancel/route"),
    import("./[releaseId]/coverage/route"),
  ]);

  api = new Hono({ strict: false });
  api.route("/api/v1/marketing/pr", rootRoute);
  api.route("/api/v1/marketing/pr/:releaseId", detailRoute);
  api.route("/api/v1/marketing/pr/:releaseId/submit", submitRoute);
  api.route("/api/v1/marketing/pr/:releaseId/cancel", cancelRoute);
  api.route("/api/v1/marketing/pr/:releaseId/coverage", coverageRoute);
});

describe("marketing PR API routes (#11819)", () => {
  beforeEach(() => {
    releases.splice(0);
    coverageRows.splice(0);
    requireUserOrApiKeyWithOrg.mockClear();
    for (const fn of Object.values(pressReleasesRepository)) {
      fn.mockClear();
    }
  });

  test("creates, lists, reads, and updates a draft release for the authed organization", async () => {
    const owner = actor("owner");
    const release = await createDraft(owner, "  Launch draft  ");

    expect(release.title).toBe("Launch draft");
    expect(release.status).toBe("draft");
    expect(release.organization_id).toBe(owner.orgId);

    const list = await fetchApi("/api/v1/marketing/pr");
    expect(list.status).toBe(200);
    const listJson = await responseJson<{ releases: PressRelease[] }>(list);
    expect(listJson.releases.map((item) => item.id)).toContain(release.id);

    const get = await fetchApi(`/api/v1/marketing/pr/${release.id}`);
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({
      success: true,
      release: { id: release.id, title: "Launch draft" },
    });

    const patch = await fetchApi(`/api/v1/marketing/pr/${release.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        summary: "Short summary",
        targetRegions: ["US", "US"],
      }),
    });
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({
      success: true,
      release: {
        id: release.id,
        summary: "Short summary",
        target_regions: ["US"],
      },
    });
  });

  test("rejects invalid create/update bodies", async () => {
    const owner = actor("invalid");
    actAs(owner);

    const badCreate = await fetchApi("/api/v1/marketing/pr", {
      method: "POST",
      body: JSON.stringify({ title: "" }),
    });
    expect(badCreate.status).toBe(400);
    await expect(badCreate.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request",
    });

    const release = await createDraft(owner);
    const badPatch = await fetchApi(`/api/v1/marketing/pr/${release.id}`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(badPatch.status).toBe(400);
    await expect(badPatch.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid request",
    });
  });

  test("enforces organization ownership on get and update", async () => {
    const owner = actor("owner-scope");
    const other = actor("other-scope");
    const release = await createDraft(owner);

    actAs(other);
    const get = await fetchApi(`/api/v1/marketing/pr/${release.id}`);
    expect(get.status).toBe(404);
    const patch = await fetchApi(`/api/v1/marketing/pr/${release.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Stolen edit" }),
    });
    expect(patch.status).toBe(404);

    const list = await fetchApi("/api/v1/marketing/pr");
    expect(list.status).toBe(200);
    const listJson = await responseJson<{ releases: PressRelease[] }>(list);
    expect(listJson.releases.map((item) => item.id)).not.toContain(release.id);
  });

  test("submit fails closed without a configured distribution provider and does not mutate release state", async () => {
    const owner = actor("submit");
    const release = await createDraft(owner);

    const submit = await fetchApi(`/api/v1/marketing/pr/${release.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: uniq("submit-key") }),
    });
    expect(submit.status).toBe(503);
    await expect(submit.json()).resolves.toMatchObject({
      success: false,
      code: "PR_PROVIDER_NOT_CONFIGURED",
    });

    const after = await pressReleaseService.getRelease(release.id, owner.orgId);
    expect(after?.status).toBe("draft");
    expect(
      pressReleasesRepository.findDistributionByIdempotencyKey,
    ).not.toHaveBeenCalled();
  });

  test("cancels draft releases and refuses to submit cancelled releases", async () => {
    const owner = actor("cancel");
    const release = await createDraft(owner);

    const cancel = await fetchApi(`/api/v1/marketing/pr/${release.id}/cancel`, {
      method: "POST",
    });
    expect(cancel.status).toBe(200);
    await expect(cancel.json()).resolves.toMatchObject({
      success: true,
      release: { id: release.id, status: "cancelled" },
    });

    const submit = await fetchApi(`/api/v1/marketing/pr/${release.id}/submit`, {
      method: "POST",
    });
    expect(submit.status).toBe(400);
    await expect(submit.json()).resolves.toMatchObject({
      success: false,
      error: "Cancelled press releases cannot be submitted",
    });
  });

  test("lists coverage for a release within the owner organization", async () => {
    const owner = actor("coverage");
    const release = await createDraft(owner);
    const coverage = await pressReleaseService.recordCoverage({
      organizationId: owner.orgId,
      releaseId: release.id,
      url: "https://example-news.test/eliza-cloud-pr",
      title: "Eliza Cloud adds PR workflow",
      outlet: "Example News",
      publishedAt: new Date("2026-07-03T12:00:00.000Z"),
    });

    const response = await fetchApi(
      `/api/v1/marketing/pr/${release.id}/coverage`,
    );
    expect(response.status).toBe(200);
    const json = await responseJson<{ coverage: PressCoverage[] }>(response);
    expect(json.coverage).toHaveLength(1);
    expect(json.coverage[0]).toMatchObject({
      id: coverage.id,
      url: "https://example-news.test/eliza-cloud-pr",
      outlet: "Example News",
    });
  });
});
