/**
 * Pins the Railway embeddings sidecar's executable image and model artifact to
 * immutable upstream identities. The deterministic source test prevents a
 * later cold build from silently following either registry's mutable default.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const dockerfile = readFileSync(
  new URL("packages/cloud/services/embeddings/Dockerfile", repoRoot),
  "utf8",
);

describe("embeddings sidecar supply-chain pins", () => {
  test("pins the default TEI image to an OCI digest", () => {
    expect(dockerfile).toMatch(
      /^ARG TEI_IMAGE=ghcr\.io\/huggingface\/text-embeddings-inference@sha256:[a-f0-9]{64}$/m,
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile interpolation, not JavaScript.
    expect(dockerfile).toContain("FROM ${TEI_IMAGE}");
  });

  test("pins the default Hugging Face model revision and passes it to TEI", () => {
    expect(dockerfile).toMatch(/^ARG EMBEDDINGS_MODEL_REVISION=[a-f0-9]{40}$/m);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Dockerfile interpolation, not JavaScript.
    expect(dockerfile).toContain("ENV REVISION=${EMBEDDINGS_MODEL_REVISION}");
  });
});
