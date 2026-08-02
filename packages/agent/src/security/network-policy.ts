/**
 * Compatibility exports for network-address policy now owned by core.
 */

export {
  decodeIpv6MappedHex,
  isBlockedPrivateOrLinkLocalIp,
  isLoopbackHost,
  normalizeHostLike,
  normalizeIpForPolicy,
} from "@elizaos/core/security/network-policy";
