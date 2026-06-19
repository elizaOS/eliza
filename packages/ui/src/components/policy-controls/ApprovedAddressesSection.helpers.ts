import type { ApprovedAddressesConfig } from "./types";

export function addressSummary(config: ApprovedAddressesConfig): string {
  const count = config.addresses?.length ?? 0;
  const mode = config.mode === "whitelist" ? "allowed" : "blocked";
  return count === 0 ? `No addresses ${mode}` : `${count} ${mode}`;
}
