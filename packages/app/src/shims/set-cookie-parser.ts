export interface SetCookieParseOptions {
  decodeValues?: boolean;
  map?: boolean;
  silent?: boolean;
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  expires?: Date;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  partitioned?: boolean;
  [key: string]: string | number | boolean | Date | undefined;
}

type HeadersLike =
  | Headers
  | Record<string, string | string[] | undefined>
  | {
      getSetCookie?: () => string[];
      get?: (name: string) => string | null;
      cookie?: string;
    };

type ParseInput =
  | string
  | string[]
  | null
  | undefined
  | { headers?: HeadersLike };

const defaultParseOptions: Required<SetCookieParseOptions> = {
  decodeValues: true,
  map: false,
  silent: false,
};

function isForbiddenKey(key: unknown): key is string {
  return typeof key !== "string" || key in {};
}

function createNullObject<T extends object>(): T {
  return Object.create(null);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseNameValuePair(nameValuePair: string): {
  name: string;
  value: string;
} {
  const parts = nameValuePair.split("=");
  if (parts.length <= 1) {
    return { name: "", value: nameValuePair };
  }

  return {
    name: parts.shift() ?? "",
    value: parts.join("="),
  };
}

export function parseString(
  setCookieValue: string,
  options?: SetCookieParseOptions,
): ParsedSetCookie | null {
  const parts = setCookieValue.split(";").filter(isNonEmptyString);
  const nameValuePair = parts.shift() ?? "";
  const parsed = parseNameValuePair(nameValuePair);
  const parseOptions = options
    ? { ...defaultParseOptions, ...options }
    : defaultParseOptions;

  if (isForbiddenKey(parsed.name)) {
    return null;
  }

  let cookieValue = parsed.value;
  if (parseOptions.decodeValues) {
    try {
      cookieValue = decodeURIComponent(cookieValue);
    } catch (error) {
      console.error(
        "set-cookie-parser: failed to decode cookie value. Set options.decodeValues=false to disable decoding.",
        error,
      );
    }
  }

  const cookie = createNullObject<ParsedSetCookie>();
  cookie.name = parsed.name;
  cookie.value = cookieValue;

  for (const part of parts) {
    const sides = part.split("=");
    const key = (sides.shift() ?? "").trimStart().toLowerCase();
    if (isForbiddenKey(key)) {
      continue;
    }
    const value = sides.join("=");
    if (key === "expires") {
      cookie.expires = new Date(value);
    } else if (key === "max-age") {
      const maxAge = Number.parseInt(value, 10);
      if (!Number.isNaN(maxAge)) {
        cookie.maxAge = maxAge;
      }
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    } else if (key === "samesite") {
      cookie.sameSite = value;
    } else if (key === "partitioned") {
      cookie.partitioned = true;
    } else if (key) {
      cookie[key] = value;
    }
  }

  return cookie;
}

function headerValueFromRecord(
  headers: Record<string, string | string[] | undefined>,
  options: Required<SetCookieParseOptions>,
): string | string[] | undefined {
  if (headers["set-cookie"]) {
    return headers["set-cookie"];
  }

  const setCookieKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === "set-cookie",
  );
  const value = setCookieKey ? headers[setCookieKey] : undefined;
  if (!value && headers.cookie && !options.silent) {
    console.warn(
      "Warning: set-cookie-parser appears to have been called on a request object. It is designed to parse Set-Cookie headers from responses, not Cookie headers from requests. Set the option {silent: true} to suppress this warning.",
    );
  }
  return value;
}

function extractHeaderInput(
  input: ParseInput,
  options: Required<SetCookieParseOptions>,
): string | string[] | null | undefined {
  if (
    !input ||
    typeof input === "string" ||
    Array.isArray(input) ||
    !("headers" in input) ||
    !input.headers
  ) {
    return input as string | string[] | null | undefined;
  }

  const headers = input.headers;
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  if (typeof headers.get === "function") {
    return headers.get("set-cookie");
  }
  return headerValueFromRecord(
    headers as Record<string, string | string[] | undefined>,
    options,
  );
}

export function parse(
  input: ParseInput,
  options?: SetCookieParseOptions,
): ParsedSetCookie[] | Record<string, ParsedSetCookie> {
  const parseOptions = options
    ? { ...defaultParseOptions, ...options }
    : defaultParseOptions;
  const headerInput = extractHeaderInput(input, parseOptions);

  if (!headerInput) {
    return parseOptions.map
      ? createNullObject<Record<string, ParsedSetCookie>>()
      : [];
  }

  const values = Array.isArray(headerInput) ? headerInput : [headerInput];
  if (!parseOptions.map) {
    return values
      .filter(isNonEmptyString)
      .map((value) => parseString(value, parseOptions))
      .filter((cookie): cookie is ParsedSetCookie => Boolean(cookie));
  }

  return values.filter(isNonEmptyString).reduce((cookies, value) => {
    const cookie = parseString(value, parseOptions);
    if (cookie && !isForbiddenKey(cookie.name)) {
      cookies[cookie.name] = cookie;
    }
    return cookies;
  }, createNullObject<Record<string, ParsedSetCookie>>());
}

export function splitCookiesString(cookiesString: unknown): string[] {
  if (Array.isArray(cookiesString)) {
    return cookiesString;
  }
  if (typeof cookiesString !== "string") {
    return [];
  }

  const source = cookiesString;
  const cookieStrings: string[] = [];
  let position = 0;
  let character = "";
  let lastComma = 0;
  let nextStart = 0;

  function skipWhitespace(): boolean {
    while (position < source.length && /\s/.test(source.charAt(position))) {
      position += 1;
    }
    return position < source.length;
  }

  function notSpecialChar(): boolean {
    character = source.charAt(position);
    return character !== "=" && character !== ";" && character !== ",";
  }

  while (position < source.length) {
    let start = position;
    let cookiesSeparatorFound = false;

    while (skipWhitespace()) {
      character = cookiesString.charAt(position);
      if (character === ",") {
        lastComma = position;
        position += 1;

        skipWhitespace();
        nextStart = position;

        while (position < source.length && notSpecialChar()) {
          position += 1;
        }

        if (position < source.length && source.charAt(position) === "=") {
          cookiesSeparatorFound = true;
          position = nextStart;
          cookieStrings.push(source.substring(start, lastComma));
          start = position;
        } else {
          position = lastComma + 1;
        }
      } else {
        position += 1;
      }
    }

    if (!cookiesSeparatorFound || position >= source.length) {
      cookieStrings.push(source.substring(start, source.length));
    }
  }

  return cookieStrings;
}

const defaultExport = Object.assign(parse, {
  parse,
  parseString,
  splitCookiesString,
});

export default defaultExport;
