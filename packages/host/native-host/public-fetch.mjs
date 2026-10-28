// fetch() for public HTTPS websites only: a native host never reaches a private
// network, loopback, link-local or other non-public address on a website's word.
// Dependency-free so a packaged host runs it without the TypeScript core. Its
// address policy is `isPrivateIpAddress` (@elizaos/core/protocol) plus the
// documentation and Teredo ranges, which a website name never legitimately uses.
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

// Separate lists per family: a BlockList also matches IPv4 addresses against IPv6
// rules (as ::ffff:a.b.c.d), which must not make every IPv4 address "private".
const PRIVATE_V4 = new BlockList();
const PRIVATE_V6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  PRIVATE_V4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
])
  PRIVATE_V6.addSubnet(network, prefix, "ipv6");

/** The IPv4 address a 6to4 (2002::/16) address embeds, or null. */
function sixToFourIpv4(address) {
  const match = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/i.exec(address);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/**
 * Whether an IP address is private, loopback, link-local, a documentation or
 * transition range, or otherwise not a public host. Anything unparsable counts
 * as private.
 */
export function privateAddress(address) {
  const value = String(address);
  const family = isIP(value);
  if (!family) return true;
  if (family === 4) return PRIVATE_V4.check(value, "ipv4");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) return privateAddress(mapped[1]);
  const embedded = sixToFourIpv4(value);
  if (embedded && privateAddress(embedded)) return true;
  return PRIVATE_V6.check(value, "ipv6");
}

const lookupAll = (host) => lookup(host, { all: true, verbatim: true });
const bare = (hostname) => String(hostname).replace(/^\[|\]$/g, "");

/** True only when the host name resolves, and every address it resolves to is public. */
export async function resolvesPublic(hostname, resolve = lookupAll) {
  const host = bare(hostname);
  if (isIP(host)) return !privateAddress(host);
  try {
    const addresses = await resolve(host);
    return (
      Array.isArray(addresses) &&
      addresses.length > 0 &&
      addresses.every(
        (entry) =>
          !privateAddress(typeof entry === "string" ? entry : entry?.address),
      )
    );
  } catch {
    return false;
  }
}

const refused = (message, code) => Object.assign(new Error(message), { code });

/**
 * A DNS lookup for the connection itself that refuses private addresses at
 * connect time. Checking a name first and letting fetch resolve it again would
 * let a short-lived DNS answer (rebinding) swap in 127.0.0.1 or a LAN address
 * between the check and the connection; here the address that is checked is the
 * one connected to.
 */
export function vettedLookup(resolve = lookupAll) {
  return (hostname, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    Promise.resolve()
      .then(() => resolve(bare(hostname)))
      .then(
        (entries) => {
          const list = (Array.isArray(entries) ? entries : []).map((entry) =>
            typeof entry === "string"
              ? { address: entry, family: isIP(entry) }
              : {
                  address: entry?.address,
                  family: entry?.family || isIP(String(entry?.address)),
                },
          );
          if (
            !list.length ||
            list.some((entry) => privateAddress(String(entry.address)))
          ) {
            callback(
              refused("This website resolves to a private address.", "EPRIVATE"),
            );
            return;
          }
          const usable = options?.family
            ? list.filter((entry) => entry.family === options.family)
            : list;
          if (!usable.length) {
            callback(refused("No usable address.", "ENOTFOUND"));
            return;
          }
          if (options?.all) callback(null, usable);
          else callback(null, usable[0].address, usable[0].family);
        },
        (error) => callback(error),
      );
  };
}

export const PUBLIC_FETCH_MAX_BYTES = 8 * 1024 * 1024;
const BROWSER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DROPPED_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
  "connection",
]);

function decode(body, encoding) {
  const limit = { maxOutputLength: PUBLIC_FETCH_MAX_BYTES + 1 };
  if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(body, limit);
  if (encoding === "deflate") return inflateSync(body, limit);
  if (encoding === "br") return brotliDecompressSync(body, limit);
  return body;
}

/**
 * fetch() for a public HTTPS website, connecting only to an address vetted at
 * connect time (see vettedLookup). Never follows redirects (callers follow them
 * by hand), sends no cookies, and reads at most 8 MB. Returns a standard Response.
 */
export function publicFetch(address, init = {}, { resolve } = {}) {
  return new Promise((done, fail) => {
    let url;
    try {
      url = new URL(address);
    } catch {
      fail(new TypeError("Invalid address."));
      return;
    }
    const host = bare(url.hostname);
    if (url.protocol !== "https:" || url.username || url.password) {
      fail(new TypeError("Only HTTPS websites without account details."));
      return;
    }
    // A literal IP is connected to without a lookup: check it here.
    if (isIP(host) && privateAddress(host)) {
      fail(refused("This website is a private address.", "EPRIVATE"));
      return;
    }
    const method = init.method ?? "GET";
    const headers = {
      "user-agent": BROWSER_AGENT,
      "accept-encoding": "gzip, deflate, br",
      ...Object.fromEntries(new Headers(init.headers ?? {})),
    };
    const request = httpsRequest(
      url,
      {
        method,
        headers,
        signal: init.signal,
        agent: false,
        lookup: vettedLookup(resolve ?? lookupAll),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > PUBLIC_FETCH_MAX_BYTES) {
            response.destroy();
            fail(new Error("Response too large."));
          } else chunks.push(chunk);
        });
        response.on("error", fail);
        response.on("end", () => {
          try {
            const status = response.statusCode ?? 0;
            if (status < 200 || status > 599) throw new Error("Unexpected response.");
            const encoding = String(response.headers["content-encoding"] || "")
              .trim()
              .toLowerCase();
            const body = decode(Buffer.concat(chunks), encoding);
            const out = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value === undefined || DROPPED_HEADERS.has(name)) continue;
              for (const item of Array.isArray(value) ? value : [value])
                out.append(name, item);
            }
            const empty = [101, 204, 205, 304].includes(status) || method === "HEAD";
            done(
              new Response(empty ? null : body, {
                status,
                statusText: response.statusMessage ?? "",
                headers: out,
              }),
            );
          } catch (error) {
            fail(error);
          }
        });
      },
    );
    request.on("error", fail);
    if (init.body !== undefined && init.body !== null) request.write(init.body);
    request.end();
  });
}
