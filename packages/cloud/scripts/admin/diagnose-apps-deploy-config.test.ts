import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DiagnosticError,
  diagnose,
} from "./diagnose-apps-deploy-config.mjs"

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function fingerprint() {
  return "SHA256:public-fingerprint-only"
}

test("accepts one exact project host without returning infrastructure addresses", async () => {
  const result = await diagnose({
    token: "project-token",
    deployHost: "203.0.113.10",
    deployKey: "private-key",
    fetchImpl: async () =>
      response({
        servers: [
          { public_net: { ipv4: { ip: "203.0.113.10" } } },
          { public_net: { ipv4: { ip: "203.0.113.11" } } },
        ],
        meta: { pagination: { last_page: 1 } },
      }),
    fingerprintImpl: fingerprint,
  })

  assert.deepEqual(result, {
    inventoryRead: "passed",
    serverCount: 2,
    configuredHostMatch: "exactly_one",
    deployKeyFingerprint: "SHA256:public-fingerprint-only",
    mutation: "none",
  })
  assert.equal(JSON.stringify(result).includes("203.0.113"), false)
})

test("rejects a configured host that matches more than one project server", async () => {
  await assert.rejects(
    () =>
      diagnose({
        token: "project-token",
        deployHost: "apps.example.test",
        lookupImpl: async () => [
          { address: "203.0.113.10", family: 4 },
        ],
        fetchImpl: async () =>
          response({
            servers: [
              { public_net: { ipv4: { ip: "203.0.113.10" } } },
              { public_net: { ipv4: { ip: "203.0.113.10" } } },
            ],
            meta: { pagination: { last_page: 1 } },
          }),
        fingerprintImpl: fingerprint,
      }),
    error =>
      error instanceof DiagnosticError &&
      error.category === "configured_host_ambiguous",
  )
})

test("classifies a protected project API failure without exposing the token or response body", async () => {
  const secret = "project-token-secret"
  await assert.rejects(
    () =>
      diagnose({
        token: secret,
        deployHost: "203.0.113.10",
        fetchImpl: async () =>
          response({ error: "invalid token " + secret }, 403),
        fingerprintImpl: fingerprint,
      }),
    error =>
      error instanceof DiagnosticError &&
      error.category === "hcloud_auth_failed" &&
      !error.message.includes(secret),
  )
})

test("classifies an unreadable deploy key before emitting any key material", async () => {
  await assert.rejects(
    () =>
      diagnose({
        token: "project-token",
        deployHost: "203.0.113.10",
        fetchImpl: async () =>
          response({
            servers: [{ public_net: { ipv4: { ip: "203.0.113.10" } } }],
            meta: { pagination: { last_page: 1 } },
          }),
        fingerprintImpl: () => {
          throw new DiagnosticError("deploy_key_unreadable")
        },
      }),
    error =>
      error instanceof DiagnosticError &&
      error.category === "deploy_key_unreadable",
  )
})

test("rejects inventory without explicit pagination metadata", async () => {
  await assert.rejects(
    () =>
      diagnose({
        token: "project-token",
        deployHost: "203.0.113.10",
        fetchImpl: async () =>
          response({
            servers: [{ public_net: { ipv4: { ip: "203.0.113.10" } } }],
          }),
        fingerprintImpl: fingerprint,
      }),
    error =>
      error instanceof DiagnosticError &&
      error.category === "hcloud_inventory_invalid",
  )
})
