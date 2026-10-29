/** Compose a product rename through the existing canonical config fields.
 * Call only after the normal config/restore selection has settled. This does
 * not authorize writes or choose an existing profile from a display label.
 */
import { ElizaError, stringToUuid } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { syncCharacterIntoConfig } from "../services/character-persistence.ts";
import {
  agentIdentityName,
  buildCharacterFromConfig,
} from "./build-character-config.ts";
import { resolveSandboxRouteAgentId } from "./sandbox-character.ts";

export function prepareProductCharacterConfig(
  config: ElizaConfig,
  product: { readonly name: string; readonly bio?: readonly string[] },
): ElizaConfig {
  const primary = config.agents?.list?.[0];
  const list = config.agents?.list ?? [];
  const configuredName = primary?.name?.trim();
  const ui = config.ui;
  const assistant = ui?.assistant;
  const uiName =
    assistant &&
    typeof assistant === "object" &&
    "name" in assistant &&
    typeof assistant.name === "string"
      ? assistant.name.trim()
      : undefined;
  const explicitIdentity = primary?.identityName;
  if (
    resolveSandboxRouteAgentId() ||
    process.env.ELIZA_AGENT_CHARACTER_JSON?.trim() ||
    process.env.ELIZA_CHARACTER_PATH?.trim() ||
    !Array.isArray(list) ||
    primary?.default === false ||
    list.some((entry, index) => index > 0 && entry.default === true) ||
    (explicitIdentity !== undefined && !explicitIdentity.trim()) ||
    (!explicitIdentity && configuredName && uiName && configuredName !== uiName)
  ) {
    throw new ElizaError(
      "Resolve the original canonical agent selection before applying product branding.",
      { code: "PRODUCT_CHARACTER_IDENTITY_UNRESOLVED" },
    );
  }
  const name = product.name.trim();
  if (
    !name ||
    Object.keys(product).some((key) => key !== "name" && key !== "bio")
  ) {
    throw new ElizaError(
      "Product branding accepts only a name and optional bio.",
      { code: "PRODUCT_CHARACTER_FIELDS_INVALID" },
    );
  }
  const original = buildCharacterFromConfig(config);
  const identityName = agentIdentityName(original);
  const originalName = original.name;
  if (!identityName || !originalName)
    throw new ElizaError("The original canonical identity is unavailable.", {
      code: "PRODUCT_CHARACTER_IDENTITY_UNRESOLVED",
    });
  const originalId = original.id ?? stringToUuid(originalName);
  const next = structuredClone(config);
  // Passing only the approved patch avoids pinning all derived preset fields,
  // settings or secrets into the canonical file.
  syncCharacterIntoConfig(next, {
    name,
    ...(product.bio !== undefined ? { bio: [...product.bio] } : {}),
    settings: { identityName },
  });
  const rebuilt = buildCharacterFromConfig(next);
  const rebuiltName = rebuilt.name;
  if (
    !rebuiltName ||
    (rebuilt.id ?? stringToUuid(rebuiltName)) !== originalId ||
    agentIdentityName(rebuilt) !== identityName
  ) {
    throw new ElizaError(
      "Product branding did not preserve the original canonical identity.",
      { code: "PRODUCT_CHARACTER_IDENTITY_CHANGED" },
    );
  }
  return next;
}
