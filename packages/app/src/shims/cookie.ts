export interface CookieParseOptions {
  decode?: (value: string) => string;
}

export interface CookieSerializeOptions {
  domain?: string;
  encode?: (value: string) => string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  partitioned?: boolean;
  path?: string;
  priority?: "low" | "medium" | "high" | string;
  sameSite?: boolean | "strict" | "lax" | "none" | string;
  secure?: boolean;
}

export type CookieValueMap = Record<string, string | undefined>;

export interface CookieStringifyOptions {
  encode?: (value: string) => string;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parse(
  cookieHeader: string | null | undefined,
  options?: CookieParseOptions,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  if (!cookieHeader) return result;

  const decode = options?.decode ?? decodeCookieValue;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (!key || result[key] !== undefined) continue;
    const value = part.slice(index + 1).trim();
    result[key] = decode(value);
  }
  return result;
}

export function serialize(
  name: string,
  value: string,
  options: CookieSerializeOptions = {},
): string {
  const encode = options.encode ?? encodeURIComponent;
  const segments = [`${name}=${encode(value)}`];

  if (Number.isFinite(options.maxAge)) {
    segments.push(`Max-Age=${Math.trunc(options.maxAge as number)}`);
  }
  if (options.domain) segments.push(`Domain=${options.domain}`);
  if (options.path) segments.push(`Path=${options.path}`);
  if (options.expires)
    segments.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) segments.push("HttpOnly");
  if (options.secure) segments.push("Secure");
  if (options.partitioned) segments.push("Partitioned");
  if (options.priority) {
    const priority =
      options.priority.charAt(0).toUpperCase() +
      options.priority.slice(1).toLowerCase();
    segments.push(`Priority=${priority}`);
  }
  if (options.sameSite) {
    const sameSite =
      options.sameSite === true
        ? "Strict"
        : options.sameSite.charAt(0).toUpperCase() +
          options.sameSite.slice(1).toLowerCase();
    segments.push(`SameSite=${sameSite}`);
  }

  return segments.join("; ");
}

export const parseCookie = parse;
export function stringifyCookie(
  cookie: CookieValueMap,
  options: CookieStringifyOptions = {},
): string {
  const encode = options.encode ?? encodeURIComponent;
  return Object.entries(cookie)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${encode(value)}`)
    .join("; ");
}

export const stringifySetCookie = serialize;
export const parseSetCookie = parse;

export default {
  parse,
  parseCookie,
  parseSetCookie,
  serialize,
  stringifyCookie,
  stringifySetCookie,
};
