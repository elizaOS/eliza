/**
 * Stop a deploy while wrangler.toml still holds placeholder ids.
 *
 * A deploy with a placeholder id uploads a Worker that cannot reach D1 or KV,
 * and the failure shows up later as a runtime error instead of a deploy error.
 * This checks the file and names the command that creates each resource.
 */
import path from "node:path";

const file = path.join(import.meta.dir, "..", "wrangler.toml");
const toml = await Bun.file(file).text();
const todos = toml
  .split("\n")
  .map((line, index) => ({ text: line.trim(), number: index + 1 }))
  .filter(
    (row) =>
      !row.text.startsWith("#") && row.text.toUpperCase().includes("TODO"),
  );

if (todos.length > 0) {
  process.stderr.write(
    `wrangler.toml still has ${todos.length} placeholder value(s):\n` +
      todos.map((row) => `  line ${row.number}: ${row.text}\n`).join("") +
      "\nCreate the resources first, then paste each id into wrangler.toml:\n" +
      "  wrangler d1 create valhalla-brain\n" +
      "  wrangler kv namespace create VALHALLA_KV\n" +
      "\nThen set the secrets. The values stay out of the repo:\n" +
      "  wrangler secret put SESSION_SECRET\n" +
      "  wrangler secret put GOOGLE_CLIENT_ID\n" +
      "  wrangler secret put ADMIN_EMAILS\n" +
      "  wrangler secret put HELIUS_API_KEY\n" +
      "Optional: BIRDEYE_API_KEY, LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_PORTAL_URL,\n" +
      "VALHALLA_MONETIZATION_PEM, MONETIZATION_URL\n",
  );
  process.exit(1);
}

process.stdout.write(
  "wrangler.toml has no placeholder values. Safe to deploy.\n",
);
