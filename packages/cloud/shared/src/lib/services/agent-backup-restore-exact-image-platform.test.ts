import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  AGENT_BACKUP_RESTORE_EXACT_IMAGE_CONFIG_MAX_BYTES,
  AGENT_BACKUP_RESTORE_EXACT_IMAGE_MANIFEST_MAX_BYTES,
  AGENT_BACKUP_RESTORE_EXACT_IMAGE_TOKEN_MAX_BYTES,
  AgentBackupRestoreExactImagePlatformError,
  type AgentBackupRestoreExactImagePlatformErrorCode,
  resolveAgentBackupRestoreExactImagePlatform,
} from "./agent-backup-restore-exact-image-platform";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";
const REPOSITORY = "elizaos/eliza";
const TAG_REFERENCE = `ghcr.io/${REPOSITORY}:restore-generation`;

type Platform = "linux/amd64" | "linux/arm64";

interface JsonObjectResponse {
  readonly body: string;
  readonly digest: string;
  readonly mediaType: string;
}

interface ImageFixture {
  readonly platform: Platform;
  readonly config: JsonObjectResponse;
  readonly child: JsonObjectResponse;
  readonly top: JsonObjectResponse;
  readonly targetDescriptor: Readonly<Record<string, unknown>>;
  readonly otherDescriptor: Readonly<Record<string, unknown>>;
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function jsonResponse(value: unknown, mediaType: string): JsonObjectResponse {
  const body = JSON.stringify(value);
  return { body, digest: sha256(body), mediaType };
}

function fixture(params: {
  platform: Platform;
  kind?: "oci" | "docker";
  simple?: boolean;
  configPlatform?: Platform;
  configMediaType?: string;
}): ImageFixture {
  const kind = params.kind ?? "oci";
  const manifestMediaType = kind === "oci" ? OCI_MANIFEST : DOCKER_MANIFEST;
  const configMediaType = params.configMediaType ?? (kind === "oci" ? OCI_CONFIG : DOCKER_CONFIG);
  const indexMediaType = kind === "oci" ? OCI_INDEX : DOCKER_INDEX;
  const [configOs, configArchitecture] = (params.configPlatform ?? params.platform).split("/");
  const config = jsonResponse(
    {
      architecture: configArchitecture,
      os: configOs,
      rootfs: { type: "layers", diff_ids: [] },
      config: {},
    },
    configMediaType,
  );
  const child = jsonResponse(
    {
      schemaVersion: 2,
      mediaType: manifestMediaType,
      config: {
        mediaType: configMediaType,
        digest: config.digest,
        size: Buffer.byteLength(config.body),
      },
      layers: [],
    },
    manifestMediaType,
  );
  const [targetOs, targetArchitecture] = params.platform.split("/");
  const otherArchitecture = targetArchitecture === "amd64" ? "arm64" : "amd64";
  const targetDescriptor = Object.freeze({
    mediaType: manifestMediaType,
    digest: child.digest,
    size: Buffer.byteLength(child.body),
    platform: { os: targetOs, architecture: targetArchitecture },
  });
  const otherDescriptor = Object.freeze({
    mediaType: manifestMediaType,
    digest: sha256(`other-${otherArchitecture}`),
    size: 128,
    platform: { os: "linux", architecture: otherArchitecture },
  });
  const top = params.simple
    ? child
    : jsonResponse(
        {
          schemaVersion: 2,
          mediaType: indexMediaType,
          manifests: [targetDescriptor, otherDescriptor],
        },
        indexMediaType,
      );
  return {
    platform: params.platform,
    config,
    child,
    top,
    targetDescriptor,
    otherDescriptor,
  };
}

function withIndexDescriptors(
  source: ImageFixture,
  descriptors: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ImageFixture {
  const top = jsonResponse(
    {
      schemaVersion: 2,
      mediaType: source.top.mediaType,
      manifests: descriptors,
    },
    source.top.mediaType,
  );
  return { ...source, top };
}

function tokenResponse(token = "registry-token"): Response {
  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function manifestResponse(params: {
  body: string;
  mediaType: string;
  digest: string;
  contentLength?: string;
}): Response {
  return new Response(params.body, {
    status: 200,
    headers: {
      "Content-Type": params.mediaType,
      "Docker-Content-Digest": params.digest,
      ...(params.contentLength ? { "Content-Length": params.contentLength } : {}),
    },
  });
}

function configCdnUrl(digest: string, shard = "ghcrblobs07"): string {
  return `https://pkg-containers.githubusercontent.com/${shard}/blobs/${digest}?sig=fixture`;
}

function configRedirectResponse(location: string, status = 307): Response {
  return new Response(null, { status, headers: { Location: location } });
}

function configResponse(params: { body: string; mediaType?: string }): Response {
  return new Response(params.body, {
    status: 200,
    headers: { "Content-Type": params.mediaType ?? "application/octet-stream" },
  });
}

function successResponses(source: ImageFixture): Array<() => Response> {
  return [
    () => tokenResponse(),
    () => manifestResponse({ ...source.top, digest: source.top.digest }),
    () => manifestResponse({ ...source.child, digest: source.child.digest }),
    () => configRedirectResponse(configCdnUrl(source.config.digest)),
    () => configResponse({ body: source.config.body }),
  ];
}

function queueFetch(responses: Array<() => Response>): {
  readonly fetchFn: typeof fetch;
  readonly calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), init });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected registry fetch ${input.toString()}`);
    return response();
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: AgentBackupRestoreExactImagePlatformErrorCode,
): Promise<AgentBackupRestoreExactImagePlatformError> {
  try {
    await promise;
  } catch (error) {
    // error-policy:J1 the test assertion boundary observes the exact typed rejection.
    expect(error).toBeInstanceOf(AgentBackupRestoreExactImagePlatformError);
    expect((error as AgentBackupRestoreExactImagePlatformError).code).toBe(code);
    return error as AgentBackupRestoreExactImagePlatformError;
  }
  throw new Error(`Expected resolver error ${code}`);
}

function resolveFixture(
  source: ImageFixture,
  fetchFn: typeof fetch,
  imageReference = TAG_REFERENCE,
) {
  return resolveAgentBackupRestoreExactImagePlatform(
    {
      imageReference,
      imageDigest: source.top.digest,
      platform: source.platform,
    },
    { fetchFn },
  );
}

function mutateSameLength(value: string): string {
  const replacement = value.endsWith("}") ? "]" : "}";
  return `${value.slice(0, -1)}${replacement}`;
}

describe("resolveAgentBackupRestoreExactImagePlatform — exact success", () => {
  test("selects the unique linux/amd64 OCI child and never fetches the tag", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const registry = queueFetch(successResponses(source));

    const result = await resolveFixture(source, registry.fetchFn);

    expect(result).toEqual({
      imageReference: `ghcr.io/${REPOSITORY}@${source.top.digest}`,
      imageDigest: source.top.digest,
      imagePlatformDigest: source.child.digest,
      platform: "linux/amd64",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(registry.calls).toHaveLength(5);
    expect(registry.calls[0]?.url).toContain("scope=repository%3Aelizaos%2Feliza%3Apull");
    expect(registry.calls[1]?.url).toEndWith(`/manifests/${encodeURIComponent(source.top.digest)}`);
    expect(registry.calls[2]?.url).toEndWith(
      `/manifests/${encodeURIComponent(source.child.digest)}`,
    );
    expect(registry.calls[3]?.url).toEndWith(`/blobs/${encodeURIComponent(source.config.digest)}`);
    expect(registry.calls[3]?.init?.redirect).toBe("manual");
    expect(registry.calls[3]?.init?.headers).toMatchObject({
      Authorization: "Bearer registry-token",
    });
    expect(registry.calls[4]?.url).toBe(configCdnUrl(source.config.digest));
    expect(registry.calls[4]?.init?.headers).not.toHaveProperty("Authorization");
    expect(registry.calls[4]?.init?.redirect).toBe("error");
    expect(registry.calls.some((call) => call.url.includes("restore-generation"))).toBe(false);
    expect(registry.calls.slice(1).every((call) => call.init?.method === "GET")).toBe(true);
  });

  test("selects the unique linux/arm64 Docker manifest-list child", async () => {
    const source = fixture({ platform: "linux/arm64", kind: "docker" });
    const registry = queueFetch(successResponses(source));

    const result = await resolveFixture(source, registry.fetchFn);

    expect(result.imagePlatformDigest).toBe(source.child.digest);
    expect(result.platform).toBe("linux/arm64");
    expect(registry.calls[1]?.init?.headers).toMatchObject({
      Authorization: "Bearer registry-token",
    });
    const accept = (registry.calls[1]?.init?.headers as Record<string, string> | undefined)?.Accept;
    expect(accept).toContain(OCI_INDEX);
    expect(accept).toContain(DOCKER_INDEX);
  });

  test("treats a simple manifest as its own child and refetches it by digest", async () => {
    const source = fixture({ platform: "linux/amd64", simple: true });
    const registry = queueFetch(successResponses(source));

    const result = await resolveFixture(
      source,
      registry.fetchFn,
      `ghcr.io/${REPOSITORY}@${source.top.digest}`,
    );

    expect(result.imageDigest).toBe(source.child.digest);
    expect(result.imagePlatformDigest).toBe(source.child.digest);
    expect(registry.calls[1]?.url).toBe(registry.calls[2]?.url);
  });

  test("accepts a matching tagged digest locator and canonicalizes it without the tag", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const registry = queueFetch(successResponses(source));

    const result = await resolveFixture(
      source,
      registry.fetchFn,
      `ghcr.io/${REPOSITORY}:restore-generation@${source.top.digest}`,
    );

    expect(result.imageReference).toBe(`ghcr.io/${REPOSITORY}@${source.top.digest}`);
    expect(registry.calls.some((call) => call.url.includes("restore-generation"))).toBe(false);
    expect(registry.calls[1]?.url).toEndWith(`/manifests/${encodeURIComponent(source.top.digest)}`);
  });

  test("does not cache verified authorities", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const registry = queueFetch([...successResponses(source), ...successResponses(source)]);

    await resolveFixture(source, registry.fetchFn);
    await resolveFixture(source, registry.fetchFn);

    expect(registry.calls).toHaveLength(10);
    expect(registry.calls.filter((call) => call.url.includes("/token"))).toHaveLength(2);
  });

  test("cancels an unexpected redirect body before following the exact CDN URL", async () => {
    const source = fixture({ platform: "linux/amd64" });
    let redirectBodyCancelled = false;
    const redirectBody = new ReadableStream({
      cancel: () => {
        redirectBodyCancelled = true;
      },
    });
    const registry = queueFetch([
      ...successResponses(source).slice(0, 3),
      () =>
        new Response(redirectBody, {
          status: 307,
          headers: { Location: configCdnUrl(source.config.digest) },
        }),
      () => configResponse({ body: source.config.body }),
    ]);

    await resolveFixture(source, registry.fetchFn);

    expect(redirectBodyCancelled).toBe(true);
  });
});

describe("resolveAgentBackupRestoreExactImagePlatform — reference authority", () => {
  test("rejects non-GHCR, bare, malformed, and divergent locators before transport", async () => {
    const source = fixture({ platform: "linux/amd64" });
    let fetchCalls = 0;
    const fetchFn = (async () => {
      fetchCalls += 1;
      throw new Error("must not fetch");
    }) as typeof fetch;
    const cases: Array<readonly [string, AgentBackupRestoreExactImagePlatformErrorCode]> = [
      ["docker.io/elizaos/eliza:latest", "IMAGE_REFERENCE_INVALID"],
      ["elizaos/eliza:latest", "IMAGE_REFERENCE_INVALID"],
      ["ghcr.io/elizaos/eliza", "IMAGE_REFERENCE_INVALID"],
      ["ghcr.io/ElizaOS/eliza:latest", "IMAGE_REFERENCE_INVALID"],
      [`ghcr.io/${REPOSITORY}:bad!tag@${source.top.digest}`, "IMAGE_REFERENCE_INVALID"],
      [`ghcr.io/${REPOSITORY}:@${source.top.digest}`, "IMAGE_REFERENCE_INVALID"],
      [`ghcr.io/${REPOSITORY}@${sha256("different")}`, "IMAGE_AUTHORITY_MISMATCH"],
      [
        `ghcr.io/${REPOSITORY}:restore-generation@${sha256("different")}`,
        "IMAGE_AUTHORITY_MISMATCH",
      ],
    ];

    for (const [imageReference, code] of cases) {
      await expectErrorCode(
        resolveAgentBackupRestoreExactImagePlatform(
          {
            imageReference,
            imageDigest: source.top.digest,
            platform: source.platform,
          },
          { fetchFn },
        ),
        code,
      );
    }
    await expectErrorCode(
      resolveAgentBackupRestoreExactImagePlatform(
        {
          imageReference: TAG_REFERENCE,
          imageDigest: "sha256:not-canonical",
          platform: source.platform,
        },
        { fetchFn },
      ),
      "IMAGE_DIGEST_INVALID",
    );
    expect(fetchCalls).toBe(0);
  });
});

describe("resolveAgentBackupRestoreExactImagePlatform — registry proof failures", () => {
  test("rejects a top-level Docker-Content-Digest mismatch", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const registry = queueFetch([
      () => tokenResponse(),
      () =>
        manifestResponse({
          ...source.top,
          digest: sha256("different-top-header"),
        }),
    ]);

    await expectErrorCode(resolveFixture(source, registry.fetchFn), "REGISTRY_DIGEST_MISMATCH");
  });

  test("rejects an index with no selected platform", async () => {
    const source = withIndexDescriptors(fixture({ platform: "linux/amd64" }), [
      fixture({ platform: "linux/amd64" }).otherDescriptor,
    ]);
    const registry = queueFetch([
      () => tokenResponse(),
      () => manifestResponse({ ...source.top, digest: source.top.digest }),
    ]);

    await expectErrorCode(resolveFixture(source, registry.fetchFn), "PLATFORM_NOT_FOUND");
  });

  test("rejects duplicate descriptors for the selected platform even when identical", async () => {
    const base = fixture({ platform: "linux/arm64" });
    const source = withIndexDescriptors(base, [base.targetDescriptor, base.targetDescriptor]);
    const registry = queueFetch([
      () => tokenResponse(),
      () => manifestResponse({ ...source.top, digest: source.top.digest }),
    ]);

    await expectErrorCode(resolveFixture(source, registry.fetchFn), "PLATFORM_AMBIGUOUS");
  });

  test("rejects a child manifest header or body that differs from its descriptor", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const headerMismatch = queueFetch([
      () => tokenResponse(),
      () => manifestResponse({ ...source.top, digest: source.top.digest }),
      () =>
        manifestResponse({
          ...source.child,
          digest: sha256("different-child-header"),
        }),
    ]);
    await expectErrorCode(
      resolveFixture(source, headerMismatch.fetchFn),
      "REGISTRY_DIGEST_MISMATCH",
    );

    const bodyMismatch = queueFetch([
      () => tokenResponse(),
      () => manifestResponse({ ...source.top, digest: source.top.digest }),
      () =>
        manifestResponse({
          body: mutateSameLength(source.child.body),
          mediaType: source.child.mediaType,
          digest: source.child.digest,
        }),
    ]);
    await expectErrorCode(resolveFixture(source, bodyMismatch.fetchFn), "REGISTRY_DIGEST_MISMATCH");
  });

  test("rejects a config CDN body that differs from its descriptor digest", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const bodyMismatch = queueFetch([
      ...successResponses(source).slice(0, 4),
      () =>
        configResponse({
          body: mutateSameLength(source.config.body),
        }),
    ]);
    await expectErrorCode(resolveFixture(source, bodyMismatch.fetchFn), "REGISTRY_DIGEST_MISMATCH");
  });

  test("rejects every malformed config CDN redirect before fetching it", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const exactLocation = configCdnUrl(source.config.digest);
    const malformedLocations = [
      ["non-HTTPS protocol", exactLocation.replace("https://", "http://")],
      [
        "foreign hostname",
        exactLocation.replace("pkg-containers.githubusercontent.com", "attacker.invalid"),
      ],
      [
        "explicit port",
        exactLocation.replace(
          "pkg-containers.githubusercontent.com",
          "pkg-containers.githubusercontent.com:444",
        ),
      ],
      ["username credential", exactLocation.replace("https://", "https://reader@")],
      ["password credential", exactLocation.replace("https://", "https://:secret@")],
      ["fragment", `${exactLocation}#unexpected`],
      [
        "missing object path prefix",
        `https://pkg-containers.githubusercontent.com/blobs/${source.config.digest}?sig=fixture`,
      ],
      [
        "unsafe path segment",
        `https://pkg-containers.githubusercontent.com/ghcr%2fescape/blobs/${source.config.digest}?sig=fixture`,
      ],
      ["mismatched digest path", configCdnUrl(sha256("other-config"))],
    ] as const;

    for (const [_clause, location] of malformedLocations) {
      const registry = queueFetch([
        ...successResponses(source).slice(0, 3),
        () => configRedirectResponse(location),
      ]);

      await expectErrorCode(resolveFixture(source, registry.fetchFn), "REGISTRY_RESPONSE_INVALID");
      expect(registry.calls).toHaveLength(4);
      expect(registry.calls[3]?.url).toEndWith(
        `/blobs/${encodeURIComponent(source.config.digest)}`,
      );
      expect(registry.calls[3]?.init?.redirect).toBe("manual");
      expect(registry.calls.some((call) => call.url === new URL(location).toString())).toBe(false);
    }
  });

  test("rejects chained config blob redirects without forwarding registry authorization", async () => {
    const source = fixture({ platform: "linux/amd64" });

    const chained = queueFetch([
      ...successResponses(source).slice(0, 4),
      () => configRedirectResponse(`${configCdnUrl(source.config.digest)}&second=1`),
    ]);
    await expectErrorCode(resolveFixture(source, chained.fetchFn), "REGISTRY_HTTP_ERROR");
    expect(chained.calls[4]?.init?.headers).not.toHaveProperty("Authorization");
    expect(chained.calls).toHaveLength(5);
  });

  test("rejects descriptor and response sizes outside their exact bounds", async () => {
    const base = fixture({ platform: "linux/amd64" });
    const oversizedDescriptor = {
      ...base.targetDescriptor,
      size: AGENT_BACKUP_RESTORE_EXACT_IMAGE_MANIFEST_MAX_BYTES + 1,
    };
    const invalidIndex = withIndexDescriptors(base, [oversizedDescriptor, base.otherDescriptor]);
    const descriptorRegistry = queueFetch([
      () => tokenResponse(),
      () => manifestResponse({ ...invalidIndex.top, digest: invalidIndex.top.digest }),
    ]);
    await expectErrorCode(
      resolveFixture(invalidIndex, descriptorRegistry.fetchFn),
      "REGISTRY_RESPONSE_INVALID",
    );

    const lengthRegistry = queueFetch([
      () => tokenResponse(),
      () =>
        manifestResponse({
          ...base.top,
          digest: base.top.digest,
          contentLength: String(AGENT_BACKUP_RESTORE_EXACT_IMAGE_MANIFEST_MAX_BYTES + 1),
        }),
    ]);
    await expectErrorCode(
      resolveFixture(base, lengthRegistry.fetchFn),
      "REGISTRY_RESPONSE_TOO_LARGE",
    );
  });

  test("bounds the token body even without a Content-Length header", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const body = JSON.stringify({
      token: "x".repeat(AGENT_BACKUP_RESTORE_EXACT_IMAGE_TOKEN_MAX_BYTES),
    });
    const registry = queueFetch([
      () =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);

    await expectErrorCode(resolveFixture(source, registry.fetchFn), "REGISTRY_RESPONSE_TOO_LARGE");
  });

  test("rejects invalid JSON after verifying its content digest", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const body = "{not-json";
    const topDigest = sha256(body);
    const registry = queueFetch([
      () => tokenResponse(),
      () =>
        manifestResponse({
          body,
          mediaType: OCI_INDEX,
          digest: topDigest,
        }),
    ]);

    await expectErrorCode(
      resolveAgentBackupRestoreExactImagePlatform(
        {
          imageReference: TAG_REFERENCE,
          imageDigest: topDigest,
          platform: source.platform,
        },
        { fetchFn: registry.fetchFn },
      ),
      "REGISTRY_RESPONSE_INVALID",
    );
  });

  test("rejects unsupported manifest and config media types", async () => {
    const invalidTop = jsonResponse(
      { schemaVersion: 2, mediaType: "application/json", manifests: [] },
      "application/json",
    );
    const topRegistry = queueFetch([
      () => tokenResponse(),
      () => manifestResponse({ ...invalidTop, digest: invalidTop.digest }),
    ]);
    await expectErrorCode(
      resolveAgentBackupRestoreExactImagePlatform(
        {
          imageReference: TAG_REFERENCE,
          imageDigest: invalidTop.digest,
          platform: "linux/amd64",
        },
        { fetchFn: topRegistry.fetchFn },
      ),
      "REGISTRY_MEDIA_TYPE_INVALID",
    );

    const invalidConfig = fixture({
      platform: "linux/amd64",
      configMediaType: "application/json",
    });
    const configRegistry = queueFetch(successResponses(invalidConfig).slice(0, 3));
    await expectErrorCode(
      resolveFixture(invalidConfig, configRegistry.fetchFn),
      "REGISTRY_MEDIA_TYPE_INVALID",
    );
  });

  test("rejects an image config that does not prove the selected platform", async () => {
    const source = fixture({
      platform: "linux/amd64",
      configPlatform: "linux/arm64",
    });
    const registry = queueFetch(successResponses(source));

    await expectErrorCode(resolveFixture(source, registry.fetchFn), "PLATFORM_CONFIG_MISMATCH");
  });

  test("rejects a config descriptor larger than the bounded config body", async () => {
    const base = fixture({ platform: "linux/amd64" });
    const childDocument = JSON.parse(base.child.body) as Record<string, unknown>;
    childDocument.config = {
      ...(childDocument.config as Record<string, unknown>),
      size: AGENT_BACKUP_RESTORE_EXACT_IMAGE_CONFIG_MAX_BYTES + 1,
    };
    const child = jsonResponse(childDocument, base.child.mediaType);
    const targetDescriptor = {
      ...base.targetDescriptor,
      digest: child.digest,
      size: Buffer.byteLength(child.body),
    };
    const source = {
      ...withIndexDescriptors(base, [targetDescriptor, base.otherDescriptor]),
      child,
      targetDescriptor,
    };
    const registry = queueFetch([
      () => tokenResponse(),
      () => manifestResponse({ ...source.top, digest: source.top.digest }),
      () => manifestResponse({ ...source.child, digest: source.child.digest }),
    ]);

    await expectErrorCode(resolveFixture(source, registry.fetchFn), "REGISTRY_RESPONSE_INVALID");
  });
});

describe("resolveAgentBackupRestoreExactImagePlatform — cancellation and transport", () => {
  test("propagates caller cancellation into an in-flight registry fetch", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const controller = new AbortController();
    const abortReason = new Error("caller cancelled restore image resolution");
    let enteredFetch: (() => void) | undefined;
    const fetchEntered = new Promise<void>((resolve) => {
      enteredFetch = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      enteredFetch?.();
      return await new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => reject(observedSignal?.reason), {
          once: true,
        });
      });
    }) as typeof fetch;
    const resolution = resolveAgentBackupRestoreExactImagePlatform(
      {
        imageReference: TAG_REFERENCE,
        imageDigest: source.top.digest,
        platform: source.platform,
        signal: controller.signal,
      },
      { fetchFn },
    );
    await fetchEntered;

    controller.abort(abortReason);

    try {
      await resolution;
      throw new Error("Expected caller cancellation");
    } catch (error) {
      // error-policy:J1 the test assertion boundary observes the caller's abort reason.
      expect(error).toBe(abortReason);
    }
    expect(observedSignal?.aborted).toBe(true);
  });

  test("rejects cancellation observed while the final verified body settles", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const controller = new AbortController();
    const abortReason = new Error("caller cancelled before final image authority");
    const responses = successResponses(source);
    responses[4] = () => {
      controller.abort(abortReason);
      return configResponse({ body: source.config.body });
    };
    const registry = queueFetch(responses);

    try {
      await resolveAgentBackupRestoreExactImagePlatform(
        {
          imageReference: TAG_REFERENCE,
          imageDigest: source.top.digest,
          platform: source.platform,
          signal: controller.signal,
        },
        { fetchFn: registry.fetchFn },
      );
      throw new Error("Expected final-body caller cancellation");
    } catch (error) {
      // error-policy:J1 the test assertion boundary observes the caller's abort reason.
      expect(error).toBe(abortReason);
    }
    expect(controller.signal.aborted).toBe(true);
  });

  test("fails closed on transport errors", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const fetchFn = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;

    const error = await expectErrorCode(
      resolveFixture(source, fetchFn),
      "REGISTRY_TRANSPORT_ERROR",
    );
    expect((error.cause as Error).message).toBe("ECONNRESET");
  });

  test("enforces one bounded deadline across registry requests", async () => {
    const source = fixture({ platform: "linux/amd64" });
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;

    await expectErrorCode(
      resolveAgentBackupRestoreExactImagePlatform(
        {
          imageReference: TAG_REFERENCE,
          imageDigest: source.top.digest,
          platform: source.platform,
        },
        { fetchFn, timeoutMs: 5 },
      ),
      "REGISTRY_TIMEOUT",
    );
  });
});
