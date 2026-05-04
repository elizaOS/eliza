/**
 * Provision a steward tenant for waifu.fun
 *
 * Usage:
 *   STEWARD_API_URL=http://steward:3200 \
 *   STEWARD_PLATFORM_KEYS=stw_plat... \
 *   bun run packages/scripts/provision-waifu-tenant.ts
 */

const STEWARD_URL = process.env.STEWARD_API_URL || "http://localhost:8787/steward";
const PLATFORM_KEY = (process.env.STEWARD_PLATFORM_KEYS ?? "").split(",")[0].trim();

if (!PLATFORM_KEY) {
  console.error("STEWARD_PLATFORM_KEYS is required");
  process.exit(1);
}

console.log(`Provisioning waifu tenant on ${STEWARD_URL}...`);

const res = await fetch(`${STEWARD_URL}/platform/tenants`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Steward-Platform-Key": PLATFORM_KEY,
  },
  body: JSON.stringify({
    id: "waifu",
    name: "waifu.fun",
  }),
});

const data = await res.json();

if (res.ok) {
  console.log("✅ Tenant created:");
  console.log(`   ID: waifu`);
  console.log(`   API Key: ${data.data?.apiKey ?? "(check response)"}`);
  console.log("\nAdd to waifu.fun .env:");
  console.log(`   STEWARD_TENANT_ID=waifu`);
  console.log(`   STEWARD_TENANT_API_KEY=${data.data?.apiKey ?? "..."}`);
} else if (res.status === 409) {
  console.log("ℹ️ Tenant 'waifu' already exists");
} else {
  console.error("❌ Failed:", data);
  process.exit(1);
}
