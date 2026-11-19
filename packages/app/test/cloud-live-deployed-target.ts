/** Fixed first-party origins for credentialed deployed-browser smoke tests. */
import { createHash, randomBytes } from "node:crypto";
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";
import type { Page } from "@playwright/test";

export const STAGING_PAGES_ALIAS = "https://staging.eliza-app.pages.dev";

export function cloudLiveDeployedRendererOrigin(
  environment: string | undefined,
): string {
  if (environment === "production")
    return ELIZA_DOMAIN_CONTRACTS.production.cloudAppOrigin;
  if (!environment || environment === "staging") {
    return ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;
  }
  throw new Error("Unsupported deployed Cloud smoke environment");
}

export async function requireStagingJoinBytes(
  page: Page,
  origin: string,
  expectedHash: string | undefined,
): Promise<void> {
  const hash = await page.evaluate(async (origin) => {
    if (window !== window.top || location.origin !== origin)
      throw new Error("Unexpected staging document origin");
    const response = await fetch("/join", {
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    if (
      response.status !== 200 ||
      response.url !== origin + "/join" ||
      response.headers.get("content-type")?.split(";")[0]?.trim() !==
        "text/html"
    )
      throw new Error("Unexpected staging join document");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await response.arrayBuffer(),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }, origin);
  if (hash !== expectedHash)
    throw new Error(
      "Staging join document does not match the attested renderer",
    );
}

/** Runs inside the verified top-level JSON document, before any app script loads. */
async function establishStagingBrowserSession(input: {
  appOrigin: string;
  apiOrigin: string;
  apiKey: string;
  storageKey: string;
  verifier: string;
  challenge: string;
}): Promise<void> {
  const { appOrigin, apiOrigin } = input;
  if (
    window !== window.top ||
    location.href !== `${appOrigin}/eliza-renderer-build.json` ||
    document.contentType !== "application/json"
  ) {
    throw new Error("Staging sign-in requires the verified top-level manifest");
  }

  const options = {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  } as const;
  const exchangeUrl = `${apiOrigin}/api/auth/staging-session-exchange`;
  const mint = await fetch(`${exchangeUrl}/mint`, {
    ...options,
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({ codeChallenge: input.challenge }),
  });
  const grant = await mint.json().catch(() => null);
  if (
    !mint.ok ||
    grant?.ok !== true ||
    typeof grant.code !== "string" ||
    !grant.code
  ) {
    const reason =
      mint.status === 403 && grant?.code === "subject_not_eligible"
        ? " (subject_not_eligible)"
        : "";
    throw new Error(
      `Protected staging session mint failed with HTTP ${mint.status}${reason}`,
    );
  }
  const exchange = await fetch(`${exchangeUrl}/exchange`, {
    ...options,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: grant.code, codeVerifier: input.verifier }),
  });
  const session = await exchange.json().catch(() => null);
  if (
    !exchange.ok ||
    session?.ok !== true ||
    typeof session.token !== "string" ||
    !session.token
  ) {
    throw new Error(
      `Protected staging session exchange failed with HTTP ${exchange.status}`,
    );
  }
  localStorage.setItem(input.storageKey, session.token);
}

async function readPublicJsonDocument(page: Page, url: string) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (
    response?.status() !== 200 ||
    response.url() !== url ||
    response.request().redirectedFrom() ||
    response.headers()["content-type"]?.split(";")[0]?.trim() !==
      "application/json"
  ) {
    throw new Error("Staging sign-in requires the exact public JSON document");
  }
  return response.json();
}

export async function openAuthenticatedStagingJoin(
  page: Page,
  renderer: {
    commit: string;
    buildId: string;
    indexHtmlSha256: string;
    assetCount: number;
  },
  seed: { token: string; storageKey: string },
): Promise<void> {
  const appOrigin = ELIZA_DOMAIN_CONTRACTS.staging.cloudAppOrigin;
  const apiOrigin = ELIZA_DOMAIN_CONTRACTS.staging.cloudApiOrigin;
  const health = await readPublicJsonDocument(page, `${apiOrigin}/api/health`);
  if (
    health?.status !== "ok" ||
    health.environment !== "staging" ||
    health.commit !== renderer.commit
  ) {
    throw new Error(
      "Staging session issuer does not serve the attested release",
    );
  }
  const documentManifest = await readPublicJsonDocument(
    page,
    `${appOrigin}/eliza-renderer-build.json`,
  );
  if (
    documentManifest?.commit !== renderer.commit ||
    documentManifest.buildId !== renderer.buildId ||
    documentManifest.indexHtmlSha256 !== renderer.indexHtmlSha256 ||
    documentManifest.assetCount !== renderer.assetCount ||
    documentManifest.playwrightTestAuth !== false
  ) {
    throw new Error("Staging sign-in requires the same attested renderer");
  }
  const verifier = randomBytes(32).toString("hex");
  await page.evaluate(establishStagingBrowserSession, {
    appOrigin,
    apiOrigin,
    apiKey: seed.token,
    storageKey: seed.storageKey,
    verifier,
    challenge: createHash("sha256").update(verifier).digest("hex"),
  });
  await page.goto(`${appOrigin}/join`, { waitUntil: "domcontentloaded" });
}
