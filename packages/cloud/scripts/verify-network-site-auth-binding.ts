/** Emits only the staging binding names admitted for the existing atomic secret queue. */

import process from "node:process";

const deployEnvironment = process.env.DEPLOY_ENVIRONMENT;
const enabled = process.env.NETWORK_SITE_AUTH_ENABLED;

if (
  deployEnvironment !== "staging" ||
  enabled === undefined ||
  enabled === ""
) {
  process.exit(0);
}
if (enabled === "false") {
  process.stdout.write("NETWORK_SITE_AUTH_ENABLED\n");
  process.exit(0);
}
if (enabled !== "true") {
  console.error(
    "::error::NETWORK_SITE_AUTH_ENABLED must be absent, true, or false",
  );
  process.exit(1);
}

const origin = process.env.NETWORK_SITE_AUTH_ORIGIN;
const token = process.env.NETWORK_SITE_AUTH_SERVER_TOKEN;
let url: URL | undefined;
try {
  url = new URL(origin ?? "");
} catch {
  // error-policy:J3 A malformed candidate admits no binding names.
}
if (
  url?.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
  url.origin !== origin ||
  url.pathname !== "/" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  typeof token !== "string" ||
  token.length < 32
) {
  console.error(
    "::error::Staging Network site auth requires an exact HTTP loopback origin and a server token of at least 32 characters",
  );
  process.exit(1);
}
process.stdout.write(
  "NETWORK_SITE_AUTH_ENABLED\nNETWORK_SITE_AUTH_ORIGIN\nNETWORK_SITE_AUTH_SERVER_TOKEN\n",
);
