#!/usr/bin/env node
// Cloud route e2e: resolve/create a REAL Eliza Cloud agent and prove its runtime
// answers status/health/auth. The create body has no `alwaysOn` (or another
// dedicated-tier signal), so a fresh agent is SHARED by default. This is not
// proof of managed dedicated/Hetzner ingress; that contract belongs to
// managed-dedicated-canary.ts. Programmatic surface only; the on-device
// cloud surface is driven by the Playwright Android suite (ELIZA_ANDROID_BACKEND
// =cloud) once a runtime URL + token are known.
//
// Usage:
//   ELIZA_CLOUD_AUTH_TOKEN=... node scripts/cloud-provisioning-e2e.mjs
//   [--cloud-api-base https://api.elizacloud.ai] [--agent-id <id>] [--fresh-agent]
//   [--timeout-ms 600000] [--report <path>] [--print-runtime-url]
import fs from "node:fs";

const arg = (name, fb) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fb;
};
const has = (name) => process.argv.includes(name);

const token =
  arg("--token") ??
  process.env.ELIZA_CLOUD_AUTH_TOKEN ??
  process.env.ELIZAOS_CLOUD_API_KEY ??
  process.env.ELIZACLOUD_API_KEY;
const cloudApiBase = (
  arg("--cloud-api-base") ??
  process.env.ELIZA_CLOUD_API_BASE ??
  "https://api.elizacloud.ai"
).replace(/\/+$/, "");
const agentIdArg = arg("--agent-id") ?? process.env.ELIZA_CLOUD_AGENT_ID;
const agentName =
  arg("--agent-name") ??
  process.env.ELIZA_CLOUD_AGENT_NAME ??
  "Eliza Android Cloud E2E";
const timeoutMs = Number(arg("--timeout-ms") ?? 600_000);
const pollMs = Number(arg("--poll-ms") ?? 3_000);
const reportPath = arg("--report");

const log = (m) => console.log(`[cloud-e2e] ${m}`);
const redact = (v) =>
  token ? String(v).replaceAll(token, "<redacted-token>") : String(v);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const tryJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const rec = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
const data = (v) => rec(rec(v)?.data) ?? rec(v);
const str = (...xs) => {
  for (const x of xs) if (typeof x === "string" && x.trim()) return x.trim();
  return null;
};

function requireToken() {
  if (!token?.trim()) {
    throw new Error(
      "Missing Cloud token. Set ELIZA_CLOUD_AUTH_TOKEN (or pass --token).",
    );
  }
  return token.trim();
}

function runtimeUrlFrom(...vals) {
  for (const v of vals) {
    const o = rec(v);
    if (!o) continue;
    const url = str(
      o.bridgeUrl,
      o.bridge_url,
      o.webUiUrl,
      o.web_ui_url,
      o.runtimeUrl,
      o.runtime_url,
      o.containerUrl,
      o.container_url,
      o.apiBase,
      o.api_base,
    );
    if (url) return url.replace(/\/+$/, "");
  }
  return null;
}

function normStatus(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (["complete", "completed", "success", "succeeded"].includes(s))
    return "completed";
  if (["fail", "failed", "error"].includes(s)) return "failed";
  return s || "unknown";
}

async function cloud(path, init = {}) {
  const url = `${cloudApiBase}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireToken()}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = tryJson(text) ?? text;
  const ok =
    (res.status >= 200 && res.status < 300) || rec(body)?.success === true;
  if (!ok) {
    const detail =
      str(rec(body)?.error, rec(body)?.message, rec(body)?.reason) ??
      text.slice(0, 300);
    const err = new Error(
      `Cloud request failed (${res.status}) ${url}: ${detail}`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { status: res.status, body, text };
}

async function resolveAgent() {
  if (agentIdArg?.trim()) {
    const res = await cloud(
      `/api/v1/eliza/agents/${encodeURIComponent(agentIdArg.trim())}`,
    );
    const d = data(res.body);
    if (!d) throw new Error(`Cloud agent not found: ${agentIdArg}`);
    return { ...d, id: str(d.id, d.agentId) ?? agentIdArg.trim() };
  }
  if (!has("--fresh-agent")) {
    const res = await cloud("/api/v1/eliza/agents");
    const list = Array.isArray(rec(res.body)?.data)
      ? rec(res.body).data
      : Array.isArray(res.body)
        ? res.body
        : [];
    const existing = list.map((x) => data(x) ?? x).filter(Boolean);
    const named = existing.find(
      (a) => str(a.agentName, a.name, a.agent_name) === agentName,
    );
    const chosen = named ?? existing[0];
    if (chosen) return chosen;
  }
  const res = await cloud("/api/v1/eliza/agents", {
    method: "POST",
    body: JSON.stringify({ agentName }),
  });
  const d = data(res.body);
  const id = str(d?.id, d?.agentId, d?.agent_id);
  if (!id) throw new Error(`Cloud create returned no agent id: ${res.text}`);
  return { ...d, id };
}

async function provision(agentId) {
  log(`provisioning agent=${agentId}`);
  const res = await cloud(
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/provision`,
    { method: "POST" },
  );
  const d = data(res.body) ?? {};
  return {
    jobId: str(d.jobId, d.job_id, d.id),
    runtimeUrl: runtimeUrlFrom(d, res.body),
    status: normStatus(str(d.status, d.state)),
  };
}

async function waitForRuntimeUrl(agentId, p) {
  if (p.runtimeUrl) return p.runtimeUrl;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (p.jobId) {
      const job = data(
        (await cloud(`/api/v1/jobs/${encodeURIComponent(p.jobId)}`)).body,
      );
      const url = runtimeUrlFrom(rec(job?.result), job);
      if (url) return url;
      if (normStatus(str(job?.status, job?.state, job?.phase)) === "failed") {
        throw new Error(
          `Cloud provision job failed: ${str(job?.error, job?.message) ?? "unknown error"}`,
        );
      }
    }
    const agent = await cloud(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
    ).catch(() => null);
    const url = runtimeUrlFrom(data(agent?.body));
    if (url) return url;
    await delay(pollMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for Cloud runtime URL.`,
  );
}

async function probe(runtimeUrl) {
  const failures = [];
  for (const endpoint of ["/api/status", "/api/health", "/api/auth/me"]) {
    const url = `${runtimeUrl}${endpoint}`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${requireToken()}`,
          "X-ElizaOS-Client-Id": "cloud-provisioning-e2e",
        },
      });
      const text = await res.text();
      if (res.ok)
        return {
          ok: true,
          url,
          status: res.status,
          body: tryJson(text) ?? text.slice(0, 300),
        };
      failures.push({ url, status: res.status, body: text.slice(0, 300) });
    } catch (error) {
      failures.push({ url, error: String(error) });
    }
  }
  throw new Error(
    `Provisioned runtime did not answer: ${JSON.stringify(failures)}`,
  );
}

async function main() {
  requireToken();
  const agent = await resolveAgent();
  const agentId = str(agent.id, agent.agentId, agent.agent_id);
  if (!agentId) throw new Error("Selected Cloud agent has no id.");
  const p = await provision(agentId);
  const runtimeUrl = await waitForRuntimeUrl(agentId, p);
  log(`runtime URL: ${runtimeUrl}`);
  const probeResult = await probe(runtimeUrl);
  const report = {
    ok: true,
    agentId,
    runtimeUrl,
    provision: p,
    probe: probeResult,
  };
  if (reportPath)
    fs.writeFileSync(
      reportPath,
      `${redact(JSON.stringify(report, null, 2))}\n`,
    );
  if (has("--print-runtime-url")) console.log(`RUNTIME_URL=${runtimeUrl}`);
  log("CLOUD PROVISIONING OK ✅");
  console.log(redact(JSON.stringify(report, null, 2)));
}

main().catch((error) => {
  console.error(`[cloud-e2e] FAILED: ${redact(error?.message ?? error)}`);
  if (error?.body) console.error(redact(JSON.stringify(error.body, null, 2)));
  process.exit(1);
});
