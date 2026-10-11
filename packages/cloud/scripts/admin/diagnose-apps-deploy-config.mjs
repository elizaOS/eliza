import { spawnSync } from "node:child_process"
import { promises as dns } from "node:dns"
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { isIP } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

const API_BASE_URL = "https://api.hetzner.cloud/v1"
const INVENTORY_PAGE_SIZE = 50
const REQUEST_TIMEOUT_MS = 10_000

export class DiagnosticError extends Error {
  constructor(category) {
    super(category)
    this.category = category
  }
}

function fail(category) {
  throw new DiagnosticError(category)
}

function safeUnique(values) {
  return [...new Set(values)]
}

async function resolveConfiguredHost(host, lookup = dns.lookup) {
  const normalized = typeof host === "string" ? host.trim() : ""
  if (!normalized || /\s/.test(normalized) || normalized.includes("/")) {
    fail("deploy_host_invalid")
  }

  const literalFamily = isIP(normalized)
  if (literalFamily) return [normalized]

  let records
  try {
    records = await lookup(normalized, { all: true, verbatim: true })
  } catch {
    fail("deploy_host_dns_failed")
  }

  const addresses = safeUnique(
    records
      .map(record => record.address)
      .filter(address => typeof address === "string" && isIP(address)),
  )
  if (addresses.length === 0) fail("deploy_host_dns_failed")
  return addresses
}

async function readInventory(token, fetchImpl, apiBaseUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(
      apiBaseUrl.replace(/\/+$/, "") +
        "/servers?per_page=" +
        String(INVENTORY_PAGE_SIZE),
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + token,
        },
        signal: controller.signal,
      },
    )
  } catch {
    fail("hcloud_request_failed")
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 401 || response.status === 403) {
    fail("hcloud_auth_failed")
  }
  if (!response.ok) fail("hcloud_http_failed")

  let payload
  try {
    payload = await response.json()
  } catch {
    fail("hcloud_response_invalid")
  }
  if (!payload || !Array.isArray(payload.servers)) {
    fail("hcloud_inventory_invalid")
  }

  const rawLastPage = payload.meta?.pagination?.last_page
  const lastPage = Number(rawLastPage)
  if (
    (typeof rawLastPage !== "number" && typeof rawLastPage !== "string") ||
    !String(rawLastPage).trim()
  ) {
    fail("hcloud_inventory_invalid")
  }
  if (!Number.isInteger(lastPage) || lastPage < 1) {
    fail("hcloud_inventory_invalid")
  }
  if (lastPage > 1) fail("hcloud_inventory_too_large")

  const servers = payload.servers.map(server => {
    const addresses = [
      server?.public_net?.ipv4?.ip,
      server?.public_net?.ipv6?.ip,
    ].filter(address => typeof address === "string" && isIP(address))
    return safeUnique(addresses)
  })

  return {
    serverCount: servers.length,
    addresses: servers,
  }
}

export function derivePublicKeyFingerprint(
  privateKey,
  spawn = spawnSync,
  tempDirectoryFactory = () => mkdtempSync(join(tmpdir(), "eliza-apps-key-")),
) {
  if (typeof privateKey !== "string" || privateKey.trim().length === 0) {
    fail("deploy_key_missing")
  }

  const directory = tempDirectoryFactory()
  const privatePath = join(directory, "id_key")
  const publicPath = join(directory, "id_key.pub")
  try {
    writeFileSync(privatePath, privateKey, { mode: 0o600 })
    const publicKey = spawn(
      "ssh-keygen",
      ["-y", "-f", privatePath],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 8192,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: process.env.HOME || "/tmp",
          DISPLAY: "none",
          SSH_ASKPASS: "/bin/false",
        },
      },
    )
    if (publicKey.error || publicKey.status !== 0 || !publicKey.stdout.trim()) {
      fail("deploy_key_unreadable")
    }

    writeFileSync(publicPath, publicKey.stdout, { mode: 0o600 })
    const fingerprint = spawn(
      "ssh-keygen",
      ["-lf", publicPath, "-E", "sha256"],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 8192,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          HOME: process.env.HOME || "/tmp",
        },
      },
    )
    if (fingerprint.error || fingerprint.status !== 0) {
      fail("deploy_key_unreadable")
    }
    const match = /^\d+\s+(SHA256:[^\s]+)\s/.exec(fingerprint.stdout)
    if (!match) fail("deploy_key_fingerprint_failed")
    return match[1]
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export async function diagnose({
  token,
  deployHost,
  deployKey,
  fetchImpl = globalThis.fetch,
  lookupImpl = dns.lookup,
  fingerprintImpl = derivePublicKeyFingerprint,
  apiBaseUrl = API_BASE_URL,
}) {
  if (typeof token !== "string" || token.trim().length === 0) {
    fail("hcloud_token_missing")
  }
  const configuredAddresses = await resolveConfiguredHost(deployHost, lookupImpl)
  const inventory = await readInventory(token, fetchImpl, apiBaseUrl)
  const matches = inventory.addresses.filter(addresses =>
    addresses.some(address => configuredAddresses.includes(address)),
  ).length

  if (matches === 0) fail("configured_host_not_in_project")
  if (matches > 1) fail("configured_host_ambiguous")

  const fingerprint = fingerprintImpl(deployKey)
  return {
    inventoryRead: "passed",
    serverCount: inventory.serverCount,
    configuredHostMatch: "exactly_one",
    deployKeyFingerprint: fingerprint,
    mutation: "none",
  }
}

function appendSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, lines.join("\n") + "\n")
}

async function main() {
  if (process.env.TARGET_ENVIRONMENT !== "staging") {
    fail("diagnostic_staging_only")
  }

  const missing = ["HCLOUD_APPS_TOKEN", "DEPLOY_HOST", "DEPLOY_SSH_KEY"].filter(
    name => !process.env[name]?.trim(),
  )
  if (missing.length > 0) {
    fail("missing_required_setting_names_" + missing.join("_"))
  }

  const result = await diagnose({
    token: process.env.HCLOUD_APPS_TOKEN,
    deployHost: process.env.DEPLOY_HOST,
    deployKey: process.env.DEPLOY_SSH_KEY,
  })
  const lines = [
    "### Staging apps deployment diagnostic",
    "",
    "- inventory read: passed",
    "- project server count: " + String(result.serverCount),
    "- configured host match: exactly one",
    "- deploy key public fingerprint: " + result.deployKeyFingerprint,
    "- host mutation: none",
  ]
  appendSummary(lines)
  for (const line of lines.slice(2)) console.log(line)
}

if (process.argv[1]?.endsWith("diagnose-apps-deploy-config.mjs")) {
  main().catch(error => {
    const category =
      error instanceof DiagnosticError ? error.category : "diagnostic_failed"
    console.error("::error::Staging apps deployment diagnostic failed: " + category)
    appendSummary([
      "### Staging apps deployment diagnostic",
      "",
      "- result: failed",
      "- category: " + category,
      "- host mutation: none",
    ])
    process.exitCode = 1
  })
}
