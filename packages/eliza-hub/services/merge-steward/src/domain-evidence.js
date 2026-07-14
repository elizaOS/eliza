export async function buildDomainEvidence({
  forgejoRootUrl,
  forgejoDomain,
  reverseProxyReviewed = false,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const root = normalizeForgejoRootUrl(forgejoRootUrl);
  const expectedDomain = forgejoDomain ?? root.hostname;
  const probe = await probeRootUrl(root, fetchImpl);
  const hostMatches = root.hostname === expectedDomain;
  const tlsVerified = root.protocol === "https:" && probe.fetchOk === true;
  const rootUrlCanonical = tlsVerified && urlsMatch(probe.finalUrl, root.href);
  const reviewed = reverseProxyReviewed === true;

  const checks = [
    check(
      "https_url",
      root.protocol === "https:",
      "domain.forgejoRootUrl",
      "Forgejo root URL must use https://",
    ),
    check(
      "host_matches",
      hostMatches,
      "domain.forgejoDomain",
      "Forgejo root URL host must match forgejoDomain",
    ),
    check(
      "tls_fetch",
      tlsVerified,
      "domain.tlsVerified",
      probe.error ??
        "HTTPS probe did not complete with verified TLS and an OK HTTP status",
    ),
    check(
      "canonical_root_url",
      rootUrlCanonical,
      "domain.rootUrlCanonical",
      "HTTPS probe did not end at the canonical Forgejo root URL",
    ),
    check(
      "reverse_proxy_reviewed",
      reviewed,
      "domain.reverseProxyReviewed",
      "Reverse proxy headers and host routing still need human review",
    ),
  ];
  const automaticChecksOk = checks
    .filter((item) => item.name !== "reverse_proxy_reviewed")
    .every((item) => item.ok);

  return {
    status: automaticChecksOk
      ? reviewed
        ? "ready"
        : "review_required"
      : "blocked",
    checkedAt: toIso(now),
    domain: {
      forgejoRootUrl: root.href,
      forgejoDomain: expectedDomain,
      tlsVerified,
      rootUrlCanonical,
      reverseProxyReviewed: reviewed,
    },
    probe: {
      statusCode: probe.statusCode,
      finalUrl: probe.finalUrl,
      error: probe.error,
    },
    checks,
  };
}

export function normalizeForgejoRootUrl(value) {
  if (value === undefined || value === null || value === "") {
    throw new TypeError("domain evidence requires forgejoRootUrl");
  }

  const root = new URL(value);
  root.search = "";
  root.hash = "";
  if (!root.pathname.endsWith("/")) {
    root.pathname = `${root.pathname}/`;
  }
  return root;
}

async function probeRootUrl(root, fetchImpl) {
  if (root.protocol !== "https:") {
    return {
      fetchOk: false,
      statusCode: null,
      finalUrl: root.href,
      error: "https_required",
    };
  }

  try {
    const response = await fetchImpl(root, {
      method: "GET",
      redirect: "follow",
    });
    const statusCode = response.status ?? null;
    const httpOk =
      response.ok === true ||
      (Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 400);
    return {
      fetchOk: httpOk,
      statusCode,
      finalUrl: response.url ? normalizeComparableUrl(response.url) : root.href,
      error: httpOk ? null : `http_status_${statusCode ?? "unknown"}`,
    };
  } catch (error) {
    // error-policy:J1 evidence probe boundary: fetch failure is reported as an
    // explicit failed probe result
    return {
      fetchOk: false,
      statusCode: null,
      finalUrl: root.href,
      error: error instanceof Error ? error.message : "fetch_failed",
    };
  }
}

function normalizeComparableUrl(value) {
  return normalizeForgejoRootUrl(value).href;
}

function urlsMatch(left, right) {
  try {
    return normalizeComparableUrl(left) === normalizeComparableUrl(right);
  } catch {
    // error-policy:J3 unparseable URL is an explicit non-match, never an error
    // state
    return false;
  }
}

function check(name, ok, evidence, error) {
  return {
    name,
    ok,
    evidence,
    error: ok ? null : error,
  };
}

function toIso(value) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
