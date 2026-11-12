/**
 * Site identity for the desktop browser workspace.
 *
 * Vault autofill and wallet consent must name and key the site the tab is
 * really on. Messages from a tab are written by page JS, so every field in
 * them (domain, url, hostname, origin) is a claim, not an identity. These
 * helpers take the tab's committed URL as tracked by the host and decide
 * from that alone. Kept import-free so `node --test` can load them directly.
 */

export type BrowserWorkspaceSite = {
  /** scheme://host[:port] */
  origin: string;
  hostname: string;
  /** Shown in consent titles: host[:port] for https, the full origin otherwise. */
  label: string;
};

/** Parse a committed tab URL into a site. Null for anything but http(s). */
export function resolveBrowserWorkspaceSite(
  url: string | null | undefined,
): BrowserWorkspaceSite | null {
  if (typeof url !== "string" || !url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  return {
    origin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    label: parsed.protocol === "https:" ? parsed.host : parsed.origin,
  };
}

/**
 * Saved logins store a lower-cased hostname. Treat `www.` and a trailing dot
 * as the same site; every other subdomain is a different site.
 */
export function normalizeLoginHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.endsWith(".")) value = value.slice(0, -1);
  if (value.startsWith("www.")) value = value.slice(4);
  return value;
}

export function savedLoginMatchesSite(
  loginDomain: unknown,
  site: BrowserWorkspaceSite,
): boolean {
  return (
    typeof loginDomain === "string" &&
    loginDomain.trim() !== "" &&
    normalizeLoginHost(loginDomain) === normalizeLoginHost(site.hostname)
  );
}

/** A connect grant covers one wallet kind on one exact origin. */
export function browserWorkspaceWalletGrantKey(
  walletKind: "evm" | "solana",
  site: BrowserWorkspaceSite,
): string {
  return `${walletKind}:${site.origin}`;
}

export type BrowserWorkspaceVaultLogin = {
  source: string;
  identifier: string;
  domain?: string | null;
  username?: string;
  title?: string;
  updatedAt: number;
};

export type BrowserWorkspaceVaultFieldHint = {
  kind: "username" | "password";
  selector: string;
};

export type BrowserWorkspaceVaultDeps<L extends BrowserWorkspaceVaultLogin> = {
  /** The tab's committed URL as the host knows it right now. */
  readTabUrl: () => string | null;
  listSavedLogins: (domain: string) => Promise<{ logins: readonly L[] }>;
  getAutofillAllowed: (domain: string) => Promise<boolean>;
  confirm: (options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
  }) => Promise<boolean>;
  revealSavedLogin: (
    login: L,
  ) => Promise<{ username: string; password: string }>;
};

export type BrowserWorkspaceVaultOutcome =
  | { fields: Record<string, string> }
  | { refused: string };

/**
 * Decide what, if anything, to fill for a login form. The site comes from
 * the committed tab URL. A request from a subframe, or one that claims a
 * different domain, is refused. The URL is read again after consent and
 * after the reveal; any change aborts.
 */
export async function resolveBrowserWorkspaceVaultAutofill<
  L extends BrowserWorkspaceVaultLogin,
>(
  request: {
    topFrame: boolean;
    claimedDomain?: string | null;
    fieldHints: readonly BrowserWorkspaceVaultFieldHint[];
  },
  deps: BrowserWorkspaceVaultDeps<L>,
): Promise<BrowserWorkspaceVaultOutcome> {
  if (!request.topFrame)
    return { refused: "Autofill runs only in the page itself." };
  const tabUrl = deps.readTabUrl();
  const site = resolveBrowserWorkspaceSite(tabUrl);
  if (!tabUrl || !site) return { refused: "Could not verify this site." };
  if (
    typeof request.claimedDomain === "string" &&
    request.claimedDomain.trim() !== "" &&
    normalizeLoginHost(request.claimedDomain) !==
      normalizeLoginHost(site.hostname)
  ) {
    return { refused: "The page named a different site." };
  }
  const userHint = request.fieldHints.find((h) => h.kind === "username");
  const passwordHint = request.fieldHints.find((h) => h.kind === "password");
  if (!passwordHint) return { fields: {} };

  const { logins } = await deps.listSavedLogins(site.hostname);
  const chosen = logins
    .filter((login) => savedLoginMatchesSite(login.domain, site))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!chosen) return { fields: {} };

  const sourceLabel =
    chosen.source === "1password"
      ? "1Password"
      : chosen.source === "bitwarden"
        ? "Bitwarden"
        : "local vault";
  const allowed = await deps.getAutofillAllowed(site.hostname);
  const consented =
    allowed ||
    (await deps.confirm({
      title: `Autofill ${site.label}`,
      message: `Sign in as ${chosen.username || chosen.title} from ${sourceLabel}?\n\nEliza will fill the saved username and password for this site.`,
      confirmLabel: "Allow",
      cancelLabel: "Deny",
    }));
  if (!consented) return { fields: {} };
  if (deps.readTabUrl() !== tabUrl) {
    return { refused: "The page changed before autofill." };
  }
  const reveal = await deps.revealSavedLogin(chosen);
  if (deps.readTabUrl() !== tabUrl) {
    return { refused: "The page changed before autofill." };
  }
  const fields: Record<string, string> = {};
  if (userHint) fields[userHint.selector] = reveal.username;
  fields[passwordHint.selector] = reveal.password;
  return { fields };
}

// Schemes that have no `//` but must not be read as `host:port`.
const OPAQUE_INPUT_SCHEME =
  /^(about|blob|data|file|javascript|mailto|sms|tel|vbscript|view-source):/i;

export type BrowserWorkspaceInputUrl =
  | { ok: true; url: string }
  | { ok: false; reason: "empty" | "invalid" | "unsupported" };

/**
 * Normalize what the user typed in the address bar (or passed with
 * `?browse=`). `localhost:3000` and `example.com:8443/x` are a host and
 * port, not a scheme, so they get `https://`. Root-relative paths are
 * resolved by the caller.
 */
export function parseBrowserWorkspaceInputUrl(
  raw: string,
): BrowserWorkspaceInputUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed === "about:blank") return { ok: true, url: trimmed };
  const candidate =
    /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) || OPAQUE_INPUT_SCHEME.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "unsupported" };
  }
  return { ok: true, url: parsed.toString() };
}
