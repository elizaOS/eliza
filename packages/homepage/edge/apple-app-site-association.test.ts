/**
 * Deterministic contract tests for the production eliza.app AASA edge route.
 * The edge-only release manifest, native Release target, transport limits, and
 * fail-closed deployment workflow are exercised without publishing anything.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AASA_URL,
  APPLE_CDN_AASA_URL,
  fetchAndValidateAppleCdnAasa,
  fetchAndValidateLiveAasa,
  fetchAndValidateOriginAasa,
  MAX_AASA_BYTES,
  RELEASE_APPLINK_COMPONENTS,
  validateAasaResponse,
  validateAasaResponseLocation,
  validateAppleCdnAasaResponse,
  validateReleaseAppConfiguration,
} from "../scripts/verify-aasa-response.mjs";
import {
  APPLE_APP_SITE_ASSOCIATION_URL,
  handleAppleAppSiteAssociationRequest,
} from "./apple-app-site-association";

const associationBody = readFileSync(
  new URL("./apple-app-site-association.json", import.meta.url),
  "utf8",
);

const validOriginHeaders = [
  "Content-Type: application/json",
  "Cache-Control: no-store",
  "X-Content-Type-Options: nosniff",
  "",
].join("\r\n");

function responseAt(url: string, body: BodyInit, init: ResponseInit) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function validateAsCanonicalOrigin(body: string) {
  return validateAasaResponse({
    status: "200",
    headersText: validOriginHeaders,
    body,
    canonical: body,
  });
}

function mutateAppReleaseSetting(
  project: string,
  setting: string,
  replacement: string,
) {
  const configurationList = project.match(
    /([A-Za-z0-9]+) \/\* Build configuration list for PBXNativeTarget "App" \*\/ = \{[\s\S]*?buildConfigurations = \([\s\S]*?([A-Za-z0-9]+) \/\* Release \*\//,
  );
  if (!configurationList)
    throw new Error("App Release configuration not found");
  const releaseId = configurationList[2];
  const releaseBlockPattern = new RegExp(
    `^\\t\\t${releaseId} \\/\\* Release \\*\\/ = \\{[\\s\\S]*?^\\t\\t\\};`,
    "m",
  );
  const releaseBlock = project.match(releaseBlockPattern)?.[0];
  if (!releaseBlock) throw new Error("App Release build settings not found");
  const settingPattern = new RegExp(`(${setting} = )[^;]+;`);
  if (!settingPattern.test(releaseBlock)) {
    throw new Error(`App Release ${setting} not found`);
  }
  return project.replace(
    releaseBlock,
    releaseBlock.replace(settingPattern, `$1${replacement};`),
  );
}

describe("eliza.app AASA edge Worker", () => {
  test("serves the reviewed edge-only association bytes", async () => {
    const response = await handleAppleAppSiteAssociationRequest(
      new Request(APPLE_APP_SITE_ASSOCIATION_URL),
    );

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(false);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe(associationBody);

    const association = JSON.parse(associationBody);
    expect(association).toEqual({
      applinks: {
        details: [
          {
            appIDs: ["25877RY2EH.ai.elizaos.app"],
            components: RELEASE_APPLINK_COMPONENTS,
          },
        ],
      },
      webcredentials: {
        apps: ["25877RY2EH.ai.elizaos.app"],
      },
    });
  });

  test("keeps the develop-published Pages fallback inert", () => {
    const pagesFallback = readFileSync(
      new URL(
        "../public/.well-known/apple-app-site-association",
        import.meta.url,
      ),
      "utf8",
    );
    expect(pagesFallback).toContain("TEAMID.ai.elizaos.app");
    expect(pagesFallback).not.toContain("25877RY2EH.ai.elizaos.app");
    expect(pagesFallback).not.toContain("/auth/callback");
    expect(pagesFallback).not.toContain("webcredentials");
    expect(pagesFallback).not.toBe(associationBody);
  });

  test("serves HEAD without a body and with the same metadata", async () => {
    const response = await handleAppleAppSiteAssociationRequest(
      new Request(APPLE_APP_SITE_ASSOCIATION_URL, { method: "HEAD" }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("");
  });

  test("forwards every non-exact request to the existing origin unchanged", async () => {
    const requests = [
      new Request("https://eliza.app/"),
      new Request(
        "https://eliza.app/.well-known/apple-app-site-association?cache=bust",
      ),
      new Request(
        "https://eliza.app/.well-known/apple-app-site-association-extra",
      ),
      new Request(APPLE_APP_SITE_ASSOCIATION_URL, { method: "POST" }),
      new Request(
        "https://www.eliza.app/.well-known/apple-app-site-association",
      ),
    ];

    for (const request of requests) {
      let forwarded: Request | undefined;
      const originResponse = new Response("github-pages-origin", {
        status: 207,
      });
      const response = await handleAppleAppSiteAssociationRequest(
        request,
        async (originRequest) => {
          forwarded = originRequest;
          return originResponse;
        },
      );

      expect(forwarded).toBe(request);
      expect(response).toBe(originResponse);
    }
  });

  test("keeps production routing exact and deployment fail closed", () => {
    const wranglerConfig = readFileSync(
      new URL("../wrangler-aasa.toml", import.meta.url),
      "utf8",
    );
    const workflow = readFileSync(
      new URL("../../../.github/workflows/deploy-aasa.yml", import.meta.url),
      "utf8",
    );

    expect(wranglerConfig).toContain(
      'pattern = "https://eliza.app/.well-known/apple-app-site-association"',
    );
    expect(wranglerConfig).not.toContain('pattern = "https://eliza.app/*"');
    expect(wranglerConfig).toContain(
      'globs = ["**/apple-app-site-association.json"]',
    );
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("environment: production");
    expect(workflow.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(3);
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
    expect(workflow).not.toContain("workflow_call:");
    expect(workflow).not.toContain("bun install");
    expect(workflow).toContain(
      '"packages/homepage/edge/apple-app-site-association.json"',
    );
    expect(workflow).toContain(
      '"packages/app-core/platforms/ios/App/App.xcodeproj/project.pbxproj"',
    );
    expect(workflow).toContain(
      '"packages/app-core/platforms/ios/App/App/App.entitlements"',
    );
    expect(workflow).toContain("Check AASA edge credentials");
    expect(workflow).toContain("CLOUDFLARE_API_TOKEN");
    expect(workflow).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(workflow).toContain("bun run deploy:aasa-edge");
    expect(workflow).toContain("--origin-live");
    expect(workflow).toContain("bunx wrangler@4.100.0 rollback");
    expect(workflow).toContain(
      "bunx wrangler@4.100.0 delete --config wrangler-aasa.toml --force",
    );
    expect(workflow).toContain("verify-apple-cdn:");
    expect(workflow).toContain("--apple-cdn-live");
    const cdnJob = workflow.split("  verify-apple-cdn:")[1];
    expect(cdnJob).toBeDefined();
    expect(cdnJob).not.toContain("rollback");
    expect(cdnJob).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  test("validates a captured production response and rejects stale hosting", () => {
    expect(validateAsCanonicalOrigin(associationBody)).toEqual([]);
    expect(
      validateAasaResponseLocation({
        effectiveUrl: AASA_URL,
        expectedUrl: AASA_URL,
      }),
    ).toEqual([]);

    const failures = validateAasaResponse({
      status: "302",
      headersText: [
        "HTTP/2 302",
        "Content-Type: application/octet-stream",
        "Cache-Control: public, max-age=300",
        "Location: https://example.com/association",
        "",
      ].join("\r\n"),
      body: '{"applinks":{}}',
      canonical: associationBody,
    });
    expect(failures).toContain("expected HTTP 200, received 302");
    expect(failures).toContain(
      "unexpected Content-Type: application/octet-stream",
    );
    expect(failures).toContain("response redirected unexpectedly");
    expect(failures).toContain(
      "live response bytes differ from the tracked AASA source",
    );
    expect(failures).toContain(
      "applinks does not bind exactly 25877RY2EH.ai.elizaos.app",
    );
  });

  test("rejects every unreviewed app entry, route, order, and service", () => {
    const extraDetail = JSON.parse(associationBody);
    extraDetail.applinks.details.push({
      appIDs: ["ATTACKER.ai.elizaos.app"],
      components: [{ "/": "/*" }],
    });
    expect(validateAsCanonicalOrigin(JSON.stringify(extraDetail))).toContain(
      "applinks.details must contain exactly one release app entry",
    );

    const extraAppId = JSON.parse(associationBody);
    extraAppId.applinks.details[0].appIDs.push("ATTACKER.ai.elizaos.app");
    expect(validateAsCanonicalOrigin(JSON.stringify(extraAppId))).toContain(
      "applinks does not bind exactly 25877RY2EH.ai.elizaos.app",
    );

    const missingLegacyRoute = JSON.parse(associationBody);
    missingLegacyRoute.applinks.details[0].components.splice(2, 1);
    expect(
      validateAsCanonicalOrigin(JSON.stringify(missingLegacyRoute)),
    ).toContain(
      "applinks components differ from the reviewed legacy routes plus /auth/callback",
    );

    const reorderedRoutes = JSON.parse(associationBody);
    [
      reorderedRoutes.applinks.details[0].components[1],
      reorderedRoutes.applinks.details[0].components[2],
    ] = [
      reorderedRoutes.applinks.details[0].components[2],
      reorderedRoutes.applinks.details[0].components[1],
    ];
    expect(
      validateAsCanonicalOrigin(JSON.stringify(reorderedRoutes)),
    ).toContain(
      "applinks components differ from the reviewed legacy routes plus /auth/callback",
    );

    const wrongWebCredentials = JSON.parse(associationBody);
    wrongWebCredentials.webcredentials.apps = ["ATTACKER.ai.elizaos.app"];
    expect(
      validateAsCanonicalOrigin(JSON.stringify(wrongWebCredentials)),
    ).toContain(
      "webcredentials does not bind exactly 25877RY2EH.ai.elizaos.app",
    );

    const missingWebCredentials = JSON.parse(associationBody);
    delete missingWebCredentials.webcredentials;
    expect(
      validateAsCanonicalOrigin(JSON.stringify(missingWebCredentials)),
    ).toEqual(
      expect.arrayContaining([
        "webcredentials contains unreviewed fields",
        "webcredentials does not bind exactly 25877RY2EH.ai.elizaos.app",
        "association contains unreviewed top-level services or fields",
      ]),
    );

    const extraWebCredentialField = JSON.parse(associationBody);
    extraWebCredentialField.webcredentials.passwords = true;
    expect(
      validateAsCanonicalOrigin(JSON.stringify(extraWebCredentialField)),
    ).toContain("webcredentials contains unreviewed fields");

    const extraService = JSON.parse(associationBody);
    extraService.activitycontinuation = {
      apps: ["25877RY2EH.ai.elizaos.app"],
    };
    expect(validateAsCanonicalOrigin(JSON.stringify(extraService))).toContain(
      "association contains unreviewed top-level services or fields",
    );
  });

  test("accepts Apple's CDN metadata and semantically identical JSON", () => {
    const compactBody = JSON.stringify(JSON.parse(associationBody));
    expect(compactBody).not.toBe(associationBody);

    expect(
      validateAppleCdnAasaResponse({
        status: "200",
        headersText: [
          "Content-Type: application/json; charset=utf-8",
          `Apple-From: ${AASA_URL}`,
          "Apple-Origin-Format: json",
          "Apple-Try-Direct: false",
          "X-Cache: hit-stale",
          "",
        ].join("\r\n"),
        body: compactBody,
        canonical: associationBody,
      }),
    ).toEqual([]);
  });

  test("rejects Apple CDN fallback, failure metadata, and reordered arrays", () => {
    const reordered = JSON.parse(associationBody);
    const components = reordered.applinks.details[0].components;
    [components[1], components[2]] = [components[2], components[1]];
    const failures = validateAppleCdnAasaResponse({
      status: "200",
      headersText: [
        "Content-Type: text/plain; charset=utf-8",
        "Apple-From: https://attacker.example/aasa",
        "Apple-Origin-Format: plist",
        "Apple-Failure-Reason: SWCERR00301 Bad JSON",
        "Apple-Try-Direct: true",
        "Location: https://example.com/redirect",
        "X-Cache: hit-stale",
        "",
      ].join("\r\n"),
      body: JSON.stringify(reordered),
      canonical: associationBody,
    });

    expect(failures).toContain(
      "unexpected Content-Type: text/plain; charset=utf-8",
    );
    expect(failures).toContain("response redirected unexpectedly");
    expect(failures).toContain(
      `Apple-From must be ${AASA_URL}, received https://attacker.example/aasa`,
    );
    expect(failures).toContain(
      "Apple-Origin-Format must be json, received plist",
    );
    expect(failures).toContain(
      "Apple CDN reported apple-failure-reason: SWCERR00301 Bad JSON",
    );
    expect(failures).toContain("Apple-Try-Direct must not be true");
    expect(failures).toContain(
      "Apple CDN JSON differs from the tracked AASA source",
    );
    expect(failures).toContain(
      "applinks components differ from the reviewed legacy routes plus /auth/callback",
    );
    expect(failures.some((failure) => failure.includes("X-Cache"))).toBe(false);
  });

  test("requests only the unmodified origin and Apple CDN URLs", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const failures = await fetchAndValidateLiveAasa({
      canonical: associationBody,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, init: init ?? {} });
        if (url === AASA_URL) {
          return responseAt(url, associationBody, {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
        if (url === APPLE_CDN_AASA_URL) {
          return responseAt(url, JSON.stringify(JSON.parse(associationBody)), {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Apple-From": AASA_URL,
              "Apple-Origin-Format": "json",
              "X-Cache": "hit-stale",
            },
          });
        }
        throw new Error(`unexpected URL ${url}`);
      },
    });

    expect(failures).toEqual([]);
    expect(calls.map((call) => call.url).sort()).toEqual(
      [AASA_URL, APPLE_CDN_AASA_URL].sort(),
    );
    expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
    expect(calls.every((call) => !call.url.includes("?"))).toBe(true);
  });

  test("rejects Apple CDN redirects and exact final-URL drift", async () => {
    const response = responseAt(
      "https://app-site-association.cdn-apple.com/a/v1/wrong.example",
      associationBody,
      {
        status: 302,
        headers: {
          "Content-Type": "application/json",
          "Apple-From": AASA_URL,
          "Apple-Origin-Format": "json",
          Location: APPLE_CDN_AASA_URL,
        },
      },
    );
    Object.defineProperty(response, "redirected", { value: true });
    const failures = await fetchAndValidateAppleCdnAasa({
      canonical: associationBody,
      fetchImpl: async () => response,
    });

    expect(failures).toContain(
      `expected exact AASA URL ${APPLE_CDN_AASA_URL}, received https://app-site-association.cdn-apple.com/a/v1/wrong.example`,
    );
    expect(failures).toContain("response followed a redirect unexpectedly");
    expect(failures).toContain("expected HTTP 200, received 302");
    expect(failures).toContain("response redirected unexpectedly");
  });

  test("rejects origin redirects and exact final-URL drift", async () => {
    const fetchCalls: RequestInit[] = [];
    const redirectResponse = responseAt(AASA_URL, "redirect", {
      status: 302,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Location: "https://example.com/aasa",
      },
    });
    const failures = await fetchAndValidateOriginAasa({
      canonical: associationBody,
      fetchImpl: async (_url, init) => {
        fetchCalls.push(init ?? {});
        return redirectResponse;
      },
    });

    expect(fetchCalls[0]?.redirect).toBe("manual");
    expect(failures).toContain("expected HTTP 200, received 302");
    expect(failures).toContain("response redirected unexpectedly");
  });

  test("stops and cancels an oversized streamed body", async () => {
    let delivered = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          delivered += 1;
          controller.enqueue(
            delivered === 1
              ? new Uint8Array(MAX_AASA_BYTES)
              : new Uint8Array(1),
          );
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const response = responseAt(AASA_URL, stream, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });

    await expect(
      fetchAndValidateOriginAasa({
        canonical: associationBody,
        fetchImpl: async () => response,
      }),
    ).rejects.toThrow(`response exceeds Apple's ${MAX_AASA_BYTES}-byte limit`);
    expect(delivered).toBe(2);
    expect(cancelled).toBe(true);
  });

  test("rejects oversized and malformed Content-Length before reading", async () => {
    for (const [contentLength, expected] of [
      [String(MAX_AASA_BYTES + 1), "response exceeds Apple's"],
      ["12oops", "response has invalid Content-Length: 12oops"],
    ]) {
      let pulled = false;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulled = true;
            controller.enqueue(new TextEncoder().encode(associationBody));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const response = responseAt(AASA_URL, stream, {
        status: 200,
        headers: {
          "Content-Length": contentLength,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });

      await expect(
        fetchAndValidateOriginAasa({
          canonical: associationBody,
          fetchImpl: async () => response,
        }),
      ).rejects.toThrow(expected);
      expect(pulled).toBe(false);
    }
  });

  test("aborts a timed-out fetch and rejects a partial transport", async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(
      fetchAndValidateOriginAasa({
        canonical: associationBody,
        timeoutMs: 5,
        fetchImpl: async (_url, init) => {
          observedSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            observedSignal?.addEventListener("abort", () => {
              reject(new Error("transport aborted by timeout"));
            });
          });
        },
      }),
    ).rejects.toThrow("transport aborted by timeout");
    expect(observedSignal?.aborted).toBe(true);

    const partialStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"applinks":'));
        queueMicrotask(() => {
          controller.error(new Error("connection reset after partial body"));
        });
      },
    });
    const partialResponse = responseAt(AASA_URL, partialStream, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
    await expect(
      fetchAndValidateOriginAasa({
        canonical: associationBody,
        fetchImpl: async () => partialResponse,
      }),
    ).rejects.toThrow("connection reset after partial body");
  });

  test("binds the reviewed identity to the exact Xcode App/Release target", () => {
    const project = readFileSync(
      new URL(
        "../../app-core/platforms/ios/App/App.xcodeproj/project.pbxproj",
        import.meta.url,
      ),
      "utf8",
    );
    const entitlements = readFileSync(
      new URL(
        "../../app-core/platforms/ios/App/App/App.entitlements",
        import.meta.url,
      ),
      "utf8",
    );
    expect(validateReleaseAppConfiguration({ project, entitlements })).toEqual(
      [],
    );

    const wrongReleaseBundle = mutateAppReleaseSetting(
      project,
      "PRODUCT_BUNDLE_IDENTIFIER",
      "attacker.example.app",
    );
    expect(
      validateReleaseAppConfiguration({
        project: wrongReleaseBundle,
        entitlements,
      }),
    ).toContain(
      "Xcode App/Release PRODUCT_BUNDLE_IDENTIFIER must be ai.elizaos.app, received attacker.example.app",
    );

    const wrongReleaseEntitlements = mutateAppReleaseSetting(
      project,
      "CODE_SIGN_ENTITLEMENTS",
      "App/Other.entitlements",
    );
    expect(
      validateReleaseAppConfiguration({
        project: wrongReleaseEntitlements,
        entitlements,
      }),
    ).toContain(
      "Xcode App/Release CODE_SIGN_ENTITLEMENTS must be App/App.entitlements, received App/Other.entitlements",
    );

    const unreviewedDomain = entitlements.replace(
      "<string>webcredentials:eliza.app</string>",
      "<string>webcredentials:attacker.example</string>",
    );
    const entitlementFailures = validateReleaseAppConfiguration({
      project,
      entitlements: unreviewedDomain,
    });
    expect(entitlementFailures).toContain(
      "App entitlements must contain exactly the applinks and webcredentials eliza.app domains",
    );

    const duplicateAssociatedDomains = entitlements.replace(
      "</dict>",
      "\t<key>com.apple.developer.associated-domains</key>\n\t<array>\n\t\t<string>applinks:eliza.app</string>\n\t\t<string>webcredentials:eliza.app</string>\n\t</array>\n</dict>",
    );
    expect(
      validateReleaseAppConfiguration({
        project,
        entitlements: duplicateAssociatedDomains,
      }),
    ).toContain(
      "App entitlements must contain exactly the applinks and webcredentials eliza.app domains",
    );
  });

  test("requires the exact origin URL", () => {
    expect(
      validateAasaResponseLocation({
        effectiveUrl:
          "https://www.eliza.app/.well-known/apple-app-site-association",
        expectedUrl: AASA_URL,
        redirected: true,
      }),
    ).toEqual([
      `expected exact AASA URL ${AASA_URL}, received https://www.eliza.app/.well-known/apple-app-site-association`,
      "response followed a redirect unexpectedly",
    ]);
  });
});
