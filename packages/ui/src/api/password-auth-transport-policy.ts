/**
 * Reusable owner passwords may only cross a transport that provides channel
 * confidentiality. Runtime URL trust answers which hosts the app may contact;
 * it deliberately does not claim that a plaintext private/LAN route is secret.
 */

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Whether password setup/login can safely send a reusable owner password to
 * this API base. HTTPS provides transport confidentiality. Loopback and the
 * native in-process app/agent schemes do not put the password on a network.
 * Plaintext LAN, private-name, CGNAT/Tailscale, and link-local bases are denied
 * even when the broader runtime trust policy allows dialing them.
 */
export function isPasswordAuthTransportConfidential(
  apiBase: string | undefined,
): boolean {
  const base = apiBase?.trim() ?? "";
  if (!base) return true;
  if (base.startsWith("/") && !base.startsWith("//")) return true;

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHostname(url.hostname);
  if (url.protocol === "eliza-local-agent:") {
    return url.hostname.toLowerCase() === "ipc";
  }
  if (url.protocol === "capacitor:" || url.protocol === "ionic:") {
    return isLoopbackHostname(url.hostname);
  }
  return false;
}
