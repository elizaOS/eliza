type CookieOptions = {
  domain?: string;
  encode?: (value: string) => string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  partitioned?: boolean;
  path?: string;
  priority?: "low" | "medium" | "high";
  sameSite?: boolean | "lax" | "strict" | "none";
  secure?: boolean;
};

type ParsedSetCookie = {
  name: string;
  value: string;
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  partitioned?: boolean;
  path?: string;
  priority?: string;
  sameSite?: string;
  secure?: boolean;
};

function defaultDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function defaultEncode(value: string): string {
  return encodeURIComponent(value);
}

export function parse(
  cookieHeader: string,
  options: { decode?: (value: string) => string } = {},
): Record<string, string> {
  const decode = options.decode ?? defaultDecode;
  const result: Record<string, string> = {};

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;

    const key = part.slice(0, index).trim();
    if (!key || Object.hasOwn(result, key)) continue;

    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    result[key] = decode(value);
  }

  return result;
}

export const parseCookie = parse;

export function serialize(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const encode = options.encode ?? defaultEncode;
  const segments = [`${name}=${encode(value)}`];

  if (options.maxAge !== undefined) segments.push(`Max-Age=${options.maxAge}`);
  if (options.domain) segments.push(`Domain=${options.domain}`);
  if (options.path) segments.push(`Path=${options.path}`);
  if (options.expires) segments.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) segments.push("HttpOnly");
  if (options.secure) segments.push("Secure");
  if (options.partitioned) segments.push("Partitioned");
  if (options.priority) segments.push(`Priority=${options.priority}`);
  if (options.sameSite) {
    const sameSite =
      options.sameSite === true ? "Strict" : String(options.sameSite);
    segments.push(`SameSite=${sameSite}`);
  }

  return segments.join("; ");
}

export const stringifyCookie = serialize;
export const stringifySetCookie = serialize;

export function parseSetCookie(header: string): ParsedSetCookie | undefined {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  if (!pair) return undefined;

  const index = pair.indexOf("=");
  if (index < 0) return undefined;

  const parsed: ParsedSetCookie = {
    name: pair.slice(0, index),
    value: defaultDecode(pair.slice(index + 1)),
  };

  for (const attribute of attributes) {
    const [rawKey, ...rawValue] = attribute.split("=");
    const key = rawKey?.trim().toLowerCase();
    const value = rawValue.join("=").trim();

    switch (key) {
      case "domain":
        parsed.domain = value;
        break;
      case "expires":
        parsed.expires = new Date(value);
        break;
      case "httponly":
        parsed.httpOnly = true;
        break;
      case "max-age":
        parsed.maxAge = Number(value);
        break;
      case "partitioned":
        parsed.partitioned = true;
        break;
      case "path":
        parsed.path = value;
        break;
      case "priority":
        parsed.priority = value;
        break;
      case "samesite":
        parsed.sameSite = value;
        break;
      case "secure":
        parsed.secure = true;
        break;
    }
  }

  return parsed;
}

export default {
  parse,
  parseCookie,
  parseSetCookie,
  serialize,
  stringifyCookie,
  stringifySetCookie,
};
