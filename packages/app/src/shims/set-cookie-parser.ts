type ParseOptions = {
  decodeValues?: boolean;
  map?: boolean;
  silent?: boolean;
};

type ParsedCookie = Record<string, unknown> & {
  name: string;
  value: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseNameValuePair(value: string): { name: string; value: string } {
  const parts = value.split("=");
  if (parts.length <= 1) return { name: "", value };
  return {
    name: parts.shift() ?? "",
    value: parts.join("="),
  };
}

export function parseString(
  setCookieValue: string,
  options: ParseOptions = {},
): ParsedCookie | null {
  const parts = setCookieValue.split(";").filter(isNonEmptyString);
  const nameValuePair = parts.shift();
  if (!nameValuePair) return null;

  const parsed = parseNameValuePair(nameValuePair);
  if (!parsed.name || Object.hasOwn({}, parsed.name)) return null;

  let value = parsed.value;
  if (options.decodeValues !== false) {
    try {
      value = decodeURIComponent(value);
    } catch {
      // Match set-cookie-parser's tolerant browser behavior.
    }
  }

  const cookie: ParsedCookie = { name: parsed.name, value };
  for (const part of parts) {
    const sides = part.split("=");
    const key = (sides.shift() ?? "").trimStart().toLowerCase();
    if (!key || Object.hasOwn({}, key)) continue;

    const attributeValue = sides.join("=");
    switch (key) {
      case "expires":
        cookie.expires = new Date(attributeValue);
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "max-age": {
        const maxAge = Number.parseInt(attributeValue, 10);
        if (!Number.isNaN(maxAge)) cookie.maxAge = maxAge;
        break;
      }
      case "partitioned":
        cookie.partitioned = true;
        break;
      case "samesite":
        cookie.sameSite = attributeValue;
        break;
      case "secure":
        cookie.secure = true;
        break;
      default:
        cookie[key] = attributeValue;
        break;
    }
  }

  return cookie;
}

export function splitCookiesString(cookiesString: unknown): string[] {
  if (Array.isArray(cookiesString)) return cookiesString;
  if (typeof cookiesString !== "string") return [];

  const source = cookiesString;
  const cookiesStrings: string[] = [];
  let position = 0;

  function skipWhitespace(): boolean {
    while (position < source.length && /\s/.test(source.charAt(position))) {
      position += 1;
    }
    return position < source.length;
  }

  function notSpecialChar(): boolean {
    const character = source.charAt(position);
    return character !== "=" && character !== ";" && character !== ",";
  }

  while (position < source.length) {
    let start = position;
    let separatorFound = false;

    while (skipWhitespace()) {
      const character = source.charAt(position);
      if (character !== ",") {
        position += 1;
        continue;
      }

      const lastComma = position;
      position += 1;
      skipWhitespace();
      const nextStart = position;

      while (position < source.length && notSpecialChar()) {
        position += 1;
      }

      if (position < source.length && source.charAt(position) === "=") {
        separatorFound = true;
        position = nextStart;
        cookiesStrings.push(source.substring(start, lastComma));
        start = position;
      } else {
        position = lastComma + 1;
      }
    }

    if (!separatorFound || position >= source.length) {
      cookiesStrings.push(source.substring(start));
    }
  }

  return cookiesStrings;
}

export function parse(input: unknown, options: ParseOptions = {}) {
  let normalizedInput = input;
  const inputWithHeaders = input as
    | { headers?: Headers | Record<string, unknown> }
    | undefined;

  if (inputWithHeaders?.headers) {
    const headers = inputWithHeaders.headers;
    if (typeof (headers as Headers).getSetCookie === "function") {
      normalizedInput = (headers as Headers).getSetCookie();
    } else if (!Array.isArray(headers)) {
      const headerRecord = headers as Record<string, unknown>;
      const key = Object.keys(headerRecord).find(
        (name) => name.toLowerCase() === "set-cookie",
      );
      normalizedInput = key ? headerRecord[key] : undefined;
    }
  }

  const values = Array.isArray(normalizedInput)
    ? normalizedInput
    : [normalizedInput];
  const cookies = values.filter(isNonEmptyString).flatMap(splitCookiesString);

  if (options.map) {
    return cookies.reduce<Record<string, ParsedCookie>>((result, value) => {
      const cookie = parseString(value, options);
      if (cookie) result[cookie.name] = cookie;
      return result;
    }, {});
  }

  return cookies
    .map((value) => parseString(value, options))
    .filter((value): value is ParsedCookie => value !== null);
}

export default parse;
