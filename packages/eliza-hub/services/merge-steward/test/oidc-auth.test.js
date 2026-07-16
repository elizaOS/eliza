import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { after, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { createOidcVerifier } from "../src/oidc-auth.js";

describe("OIDC auth verifier", () => {
  const issuers = [];

  after(async () => {
    await Promise.all(issuers.map((issuer) => issuer.close()));
  });

  it("verifies Eliza Cloud JWTs against discovery JWKS and required roles", async () => {
    const issuer = await startTestIssuer();
    issuers.push(issuer);

    const token = await issuer.sign({
      sub: "user-one",
      email: "user@example.invalid",
      email_verified: true,
      roles: ["steward"],
      groups: ["maintainers"],
    });
    const verifier = createOidcVerifier({
      enabled: true,
      issuerUrl: issuer.issuerUrl,
      audience: "eliza-merge-steward",
      requiredRoles: ["steward"],
    });

    const verified = await verifier.verify(token);

    assert.equal(verified.subject, "user-one");
    assert.equal(verified.payload.email_verified, true);
  });

  it("rejects tokens missing required groups", async () => {
    const issuer = await startTestIssuer();
    issuers.push(issuer);

    const token = await issuer.sign({
      sub: "user-two",
      roles: ["steward"],
      groups: ["maintainers"],
    });
    const verifier = createOidcVerifier({
      enabled: true,
      issuerUrl: issuer.issuerUrl,
      audience: "eliza-merge-steward",
      requiredGroups: ["admins"],
    });

    await assert.rejects(() => verifier.verify(token), /required groups/);
  });
});

async function startTestIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  };
  let issuerUrl;

  const server = createHttpServer((request, response) => {
    if (request.url === "/.well-known/openid-configuration") {
      return sendJson(response, {
        issuer: issuerUrl,
        jwks_uri: `${issuerUrl}/jwks`,
      });
    }
    if (request.url === "/jwks") {
      return sendJson(response, { keys: [jwk] });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  issuerUrl = `http://${address.address}:${address.port}`;

  return {
    issuerUrl,
    async sign(claims) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuerUrl)
        .setAudience("eliza-merge-steward")
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(privateKey);
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function sendJson(response, payload) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}
