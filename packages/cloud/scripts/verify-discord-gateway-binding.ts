/** Verify the selected Discord host before publishing its routing binding. */
import { pathToFileURL } from "node:url";
import { verifyCloudflareGatewayConfiguration } from "./verify-cloudflare-gateway-configuration.ts";

export async function verifyDiscordGatewayBinding(options: {
  environment: string;
  origin: string;
  bootstrapSecret: string;
  internalSecret: string;
}): Promise<void> {
  if (!options.internalSecret.trim()) {
    throw new Error(
      "Discord cutover requires the queued GATEWAY_INTERNAL_SECRET",
    );
  }
  await verifyCloudflareGatewayConfiguration({
    environment: options.environment,
    kind: "discord",
    origin: options.origin,
    bootstrapSecret: options.bootstrapSecret,
    settings: { GATEWAY_INTERNAL_SECRET: options.internalSecret },
    enabled: true,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await verifyDiscordGatewayBinding({
    environment: process.env.DEPLOY_ENVIRONMENT ?? "",
    origin: process.env.DISCORD_GATEWAY_URL ?? "",
    bootstrapSecret: process.env.GATEWAY_DISCORD_BOOTSTRAP_SECRET ?? "",
    internalSecret: process.env.GATEWAY_INTERNAL_SECRET ?? "",
  });
  console.log("Verified active Discord gateway and paired delivery credential");
}
