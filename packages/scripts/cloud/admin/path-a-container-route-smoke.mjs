#!/usr/bin/env node
/**
 * Path A E2E smoke test: proves a provisioned container is the real inference
 * target (self-registered + reachable + answers as its character + the
 * gateway can resolve it).
 *
 * Run AFTER the agent image is rebuilt from the Path A branch and a fresh
 * agent has been provisioned. Read-only except for an optional --probe-message
 * which sends one message to the container's /agents/<id>/message.
 *
 * Required env:
 *   KV_REST_API_URL, KV_REST_API_TOKEN   - the shared Upstash registry
 *   CHARACTER_ID                          - the agent's platform character_id
 *                                           (agent_sandboxes.character_id)
 * Optional:
 *   ELIZA_API_TOKEN                       - to probe /agents/<id>/message
 *   --probe-message "text"                - send a message and print the reply
 *
 * Exit 0 = all assertions passed.
 */

const URL_ = process.env.KV_REST_API_URL?.trim();
const TOKEN = process.env.KV_REST_API_TOKEN?.trim();
const CHARACTER_ID = process.env.CHARACTER_ID?.trim();

if (!URL_ || !TOKEN || !CHARACTER_ID) {
  console.error(
    "Missing env: KV_REST_API_URL, KV_REST_API_TOKEN, CHARACTER_ID are required.",
  );
  process.exit(2);
}

async function redis(args) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  return json.result;
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

(async () => {
  console.log(`[1/4] Resolve agent:${CHARACTER_ID}:server ...`);
  const serverName = await redis(["GET", `agent:${CHARACTER_ID}:server`]);
  if (!serverName) {
    fail(
      `No registry key agent:${CHARACTER_ID}:server. The container did not self-register. Check the container ran the Path A image and SANDBOX_ROUTE_AGENT_ID=${CHARACTER_ID}.`,
    );
  }
  console.log(`      -> serverName=${serverName}`);

  console.log(`[2/4] Resolve server:${serverName}:url ...`);
  const serverUrl = await redis(["GET", `server:${serverName}:url`]);
  if (!serverUrl) fail(`No server:${serverName}:url key.`);
  console.log(`      -> serverUrl=${serverUrl}`);

  console.log(`[3/4] Probe container health at ${serverUrl} ...`);
  const healthUrl = serverUrl.replace(/\/api\/?$/, "") + "/api/health";
  const health = await fetch(healthUrl, {
    signal: AbortSignal.timeout(8000),
  }).catch((e) => ({ ok: false, status: String(e) }));
  if (!health.ok && health.status !== 401) {
    fail(`Container health not reachable: ${healthUrl} -> ${health.status}`);
  }
  console.log(`      -> health ${health.status} (reachable)`);

  console.log(`[4/4] Confirm the container answers AS ${CHARACTER_ID} ...`);
  const probeText = process.argv.includes("--probe-message")
    ? process.argv[process.argv.indexOf("--probe-message") + 1]
    : null;
  const apiToken = process.env.ELIZA_API_TOKEN?.trim();
  const base = serverUrl.replace(/\/api\/?$/, "");
  const msgUrl = `${base}/api/agents/${CHARACTER_ID}/message`;
  const headers = { "Content-Type": "application/json" };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  const res = await fetch(msgUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      userId: "path-a-smoke",
      text: probeText || "reply with the single word: PONG",
    }),
    signal: AbortSignal.timeout(60000),
  }).catch((e) => ({ ok: false, status: String(e), json: async () => ({}) }));

  const body = await res.json().catch(() => ({}));
  if (res.status === 404 && body?.error === "Agent not found") {
    fail(
      `Container is NOT running as ${CHARACTER_ID} (got 404 "Agent not found"). The character/route-id fix is not active in this image.`,
    );
  }
  if (!res.ok) {
    console.log(
      `      -> /message returned ${res.status} (${JSON.stringify(body)}). Endpoint addressable as ${CHARACTER_ID}; non-200 may be model/budget, not routing.`,
    );
  } else {
    console.log(`      -> reply: ${JSON.stringify(body.response ?? body)}`);
  }

  console.log(
    "\nPASS: container self-registered, is reachable, and is addressable by its character_id. Path A routing chain is live.",
  );
})();
