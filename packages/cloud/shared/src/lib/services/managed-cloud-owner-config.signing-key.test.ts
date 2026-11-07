import { expect, test } from "bun:test";
import { exportJWK, generateKeyPair } from "jose";
import { _resetOidcKeyCacheForTests } from "../oidc/keys";
import { runWithCloudBindingsAsync } from "../runtime/cloud-bindings";
import { prepareManagedCloudOwnerEnvironment } from "./managed-cloud-owner-config";

const owner = {
  agentSandboxId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
};

test("a configured but unloadable signing ring rejects instead of dropping owner binding", async () => {
  const base = {
    OIDC_ENABLED: "true",
    OIDC_ISSUER_URL: "https://identity.example.invalid",
    ELIZA_CLOUD_AGENT_BASE_DOMAIN: "agents.example.invalid",
  };
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  try {
    // No ring at all is a deployment that deliberately has no owner proof;
    // the empty result is that documented degradation and must stay.
    expect(
      await runWithCloudBindingsAsync(base, () => prepareManagedCloudOwnerEnvironment(owner)),
    ).toEqual({});

    // A usable ring still provisions the full owner binding.
    expect(
      await runWithCloudBindingsAsync(
        { ...base, OIDC_SIGNING_JWKS: JSON.stringify([{ ...jwk, kid: "fixture", alg: "ES256" }]) },
        () => prepareManagedCloudOwnerEnvironment(owner),
      ),
    ).toMatchObject({
      ELIZA_CLOUD_OWNER_ISSUER: base.OIDC_ISSUER_URL,
      ELIZA_CLOUD_OWNER_ALGORITHM: "ES256",
      ELIZA_CLOUD_OWNER_ID: owner.userId,
      ELIZA_CLOUD_ORGANIZATION_ID: owner.organizationId,
    });

    // A ring that IS configured but cannot be loaded is a misconfiguration:
    // returning {} here provisions a managed agent with no owner binding.
    await expect(
      runWithCloudBindingsAsync({ ...base, OIDC_SIGNING_JWKS: "not-json" }, () =>
        prepareManagedCloudOwnerEnvironment(owner),
      ),
    ).rejects.toThrow("OIDC_SIGNING_JWKS is not valid JSON");
  } finally {
    _resetOidcKeyCacheForTests();
  }
});
