// Exercises coding containers behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, it } from "bun:test";
import { containersEnv } from "../config/containers-env";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import {
  buildCodingContainerCreatePayload,
  buildCodingContainerSessionResponse,
  imageRequiresDigestPin,
  isCodingContainerImageAllowed,
  RequestCodingAgentContainerRequestSchema,
} from "./coding-containers";

describe("coding container payloads", () => {
  it("uses the coding remote runner image when configured", () => {
    const payload = runWithCloudBindings(
      {
        ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE: "ghcr.io/elizaos/coding-remote-runner:test",
      },
      () =>
        buildCodingContainerCreatePayload({
          agent: "codex",
          workspacePath: "/workspace/project",
        }),
    );

    expect(payload.image).toBe("ghcr.io/elizaos/coding-remote-runner:test");
    expect(payload.port).toBe(3000);
    expect(payload.health_check_path).toBe("/health");
    expect(payload.volume_mount_path).toBe("/workspace/project");
  });

  it("lets explicit coding container image override the default", () => {
    const payload = runWithCloudBindings(
      {
        ELIZA_CLOUD_CODING_REMOTE_RUNNER_IMAGE: "ghcr.io/elizaos/coding-remote-runner:test",
      },
      () =>
        buildCodingContainerCreatePayload({
          agent: "opencode",
          container: { image: "ghcr.io/example/custom-coding-image:latest" },
        }),
    );

    expect(payload.image).toBe("ghcr.io/example/custom-coding-image:latest");
  });
});

describe("request schema", () => {
  it("defaults a missing agent to claude", () => {
    const parsed = RequestCodingAgentContainerRequestSchema.parse({});
    expect(parsed.agent).toBe("claude");
  });

  it("still honors an explicit agent", () => {
    const parsed = RequestCodingAgentContainerRequestSchema.parse({ agent: "codex" });
    expect(parsed.agent).toBe("codex");
  });

  it("accepts elizaos (the eliza-code cloud coding agent, #10059)", () => {
    const parsed = RequestCodingAgentContainerRequestSchema.parse({ agent: "elizaos" });
    expect(parsed.agent).toBe("elizaos");
    const payload = buildCodingContainerCreatePayload({ agent: parsed.agent });
    // The agent value is injected into the runner env so the container picks
    // eliza-code; nothing else keys off it, so widening the enum is additive.
    expect(payload.environment_vars.ELIZA_CODING_AGENT).toBe("elizaos");
    expect(payload.environment_vars.ELIZA_CLOUD_CODING_AGENT).toBe("elizaos");
  });

  it("rejects an unknown coding agent", () => {
    expect(() =>
      RequestCodingAgentContainerRequestSchema.parse({ agent: "totally-made-up" }),
    ).toThrow();
  });

  it("rejects dropped container fields instead of silently ignoring them", () => {
    expect(() =>
      RequestCodingAgentContainerRequestSchema.parse({ container: { cpu: 2 } }),
    ).toThrow();
    expect(() =>
      RequestCodingAgentContainerRequestSchema.parse({ container: { memory: 1024 } }),
    ).toThrow();
    expect(() =>
      RequestCodingAgentContainerRequestSchema.parse({ container: { architecture: "arm64" } }),
    ).toThrow();
  });

  it("still accepts the supported container fields", () => {
    const parsed = RequestCodingAgentContainerRequestSchema.parse({
      container: { name: "nancy", image: "ghcr.io/dexploarer/bnancy:latest" },
    });
    expect(parsed.container?.image).toBe("ghcr.io/dexploarer/bnancy:latest");
  });
});

describe("coding container session response url", () => {
  it("prefers the per-agent public HTTPS url over the internal bridge url", () => {
    const request = { agent: "claude" } as const;
    const createPayload = buildCodingContainerCreatePayload(request);
    const session = buildCodingContainerSessionResponse({
      request,
      createPayload,
      upstreamData: {
        id: "abc123de-0000-0000-0000-000000000000",
        status: "running",
        publicUrl: "https://abc123de-0000-0000-0000-000000000000.waifu.fun",
        url: "http://10.0.0.5:3000",
      },
    });

    expect(session.url).toBe("https://abc123de-0000-0000-0000-000000000000.waifu.fun");
  });

  it("falls back to the internal url when no public url is present", () => {
    const request = { agent: "claude" } as const;
    const createPayload = buildCodingContainerCreatePayload(request);
    const session = buildCodingContainerSessionResponse({
      request,
      createPayload,
      upstreamData: {
        id: "abc123de-0000-0000-0000-000000000000",
        status: "running",
        url: "http://10.0.0.5:3000",
      },
    });

    expect(session.url).toBe("http://10.0.0.5:3000");
  });
});

describe("coding container image allowlist", () => {
  const DEFAULT = ["ghcr.io/dexploarer/*", "ghcr.io/elizaos/*", "ghcr.io/waifufun/*"];

  it("allows images under an allowed prefix", () => {
    expect(isCodingContainerImageAllowed("ghcr.io/dexploarer/bnancy:latest", DEFAULT)).toBe(true);
    expect(isCodingContainerImageAllowed("ghcr.io/elizaos/eliza:stable", DEFAULT)).toBe(true);
    expect(isCodingContainerImageAllowed("ghcr.io/waifufun/runner:v2", DEFAULT)).toBe(true);
  });

  it("rejects images outside the allowlist", () => {
    expect(isCodingContainerImageAllowed("docker.io/library/nginx:latest", DEFAULT)).toBe(false);
    expect(isCodingContainerImageAllowed("ghcr.io/attacker/evil:latest", DEFAULT)).toBe(false);
    // No bare-substring bypass: prefix must match from the start.
    expect(isCodingContainerImageAllowed("evil.io/ghcr.io/elizaos/eliza:stable", DEFAULT)).toBe(
      false,
    );
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(isCodingContainerImageAllowed("  GHCR.IO/Elizaos/Eliza:Stable  ", DEFAULT)).toBe(true);
  });

  it("fails closed on an empty allowlist", () => {
    expect(isCodingContainerImageAllowed("ghcr.io/elizaos/eliza", [])).toBe(false);
  });

  it("supports an explicit wildcard opt-out", () => {
    expect(isCodingContainerImageAllowed("anything/at/all", ["*"])).toBe(true);
  });

  it("supports exact-match entries", () => {
    expect(
      isCodingContainerImageAllowed("ghcr.io/elizaos/eliza:stable", [
        "ghcr.io/elizaos/eliza:stable",
      ]),
    ).toBe(true);
    expect(
      isCodingContainerImageAllowed("ghcr.io/elizaos/eliza:dev", ["ghcr.io/elizaos/eliza:stable"]),
    ).toBe(false);
  });

  it("env getter returns the secure default when unset", () => {
    const allowlist = runWithCloudBindings({}, () => containersEnv.codingContainerImageAllowlist());
    expect(allowlist).toEqual(DEFAULT);
  });

  it("env getter parses a comma-separated override", () => {
    const allowlist = runWithCloudBindings(
      { CODING_CONTAINER_IMAGE_ALLOWLIST: "ghcr.io/foo/*, ghcr.io/bar/baz:1 " },
      () => containersEnv.codingContainerImageAllowlist(),
    );
    expect(allowlist).toEqual(["ghcr.io/foo/*", "ghcr.io/bar/baz:1"]);
  });
});

describe("coding container digest-pin gate", () => {
  const DIGEST = `a${"0".repeat(63)}`;
  const PINNED = `ghcr.io/elizaos/eliza@sha256:${DIGEST}`;

  it("never rejects when the flag is off (opt-in default)", () => {
    expect(imageRequiresDigestPin("ghcr.io/elizaos/eliza:latest", false)).toBe(false);
    expect(imageRequiresDigestPin("ghcr.io/elizaos/eliza", false)).toBe(false);
    expect(imageRequiresDigestPin(PINNED, false)).toBe(false);
  });

  it("rejects mutable refs when the flag is on", () => {
    // Explicit mutable tag.
    expect(imageRequiresDigestPin("ghcr.io/elizaos/eliza:latest", true)).toBe(true);
    // Implicit latest (no tag, no digest).
    expect(imageRequiresDigestPin("ghcr.io/elizaos/eliza", true)).toBe(true);
    // A digest that is not a full sha256:<64 hex> is not production-safe.
    expect(imageRequiresDigestPin("ghcr.io/elizaos/eliza@sha256:abc", true)).toBe(true);
  });

  it("accepts a full sha256-digest-pinned ref when the flag is on", () => {
    expect(imageRequiresDigestPin(PINNED, true)).toBe(false);
  });

  it("env getter defaults OFF and only 'true' enables it", () => {
    expect(runWithCloudBindings({}, () => containersEnv.requireDigestPinnedImages())).toBe(false);
    expect(
      runWithCloudBindings({ CONTAINER_IMAGE_REQUIRE_DIGEST: "1" }, () =>
        containersEnv.requireDigestPinnedImages(),
      ),
    ).toBe(false);
    expect(
      runWithCloudBindings({ CONTAINER_IMAGE_REQUIRE_DIGEST: "true" }, () =>
        containersEnv.requireDigestPinnedImages(),
      ),
    ).toBe(true);
  });
});
