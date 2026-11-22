// spec/os/browser/address.md, "Typed text is an address to open, words to search for, or a refusal with its reason"; spec/os/browser/address.md, "A web address is HTTP or HTTPS with a valid host, no credentials, clean text and at most 8,192 units"
import { isSecureWebAddress as secureWebAddress, isWebAddress as plainWebAddress, type AddressFacts, type DefaultProtocol, type WebAddress, type WebScheme } from "../../gen/os__browser__address.ts";
import { browserAddressInput, type BrowserAddressInput } from "./address-input.ts";

export type { AddressRefusalReason, BrowserAddressInput } from "./address-input.ts";
export type { AddressFacts, DefaultProtocol, WebAddress, WebScheme } from "../../gen/os__browser__address.ts";

const UNREADABLE = /(?=\p{ASCII})\p{Cc}|\\/u;
const WHITESPACE = /\s/;
const SEARCH_OPERATOR = /^(?:site|define|filetype|before|after):(?!\/\/)\S/i;
const HOST_PORT = /^[^\s/:]+:\d+(?:[/?#]|$)/;
const BRACKETED_HOST = /^\[[0-9a-fA-F.%]*:[0-9a-fA-F:.%]*\](?::\d+)?(?:[/?#]|$)/;
const SCHEME = /^[a-z][a-z\d+.-]*:(?:\S|$)/i;
const DOTTED_DOMAIN = /^[^\s/?#]+\.[^\s/?#]+(?:[/?#].*)?$/;
const AUTHORITY = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i;
const SERVER = /^(?:[^@]*@)?(?:\[[^\]]+\]|[^:@]+)(?::\d*)?$/;
const PROTOCOL: Readonly<Record<DefaultProtocol, "http:" | "https:">> = { DefaultHttp: "http:", DefaultHttps: "https:" };

function schemeOf(url: URL | null): WebScheme {
  return url?.protocol === "https:" ? "HttpsScheme" : url?.protocol === "http:" ? "HttpScheme" : "OtherScheme";
}

function hasUserInfo(url: URL | null): boolean {
  return url !== null && (url.username !== "" || url.password !== "");
}

export function addressFacts(input: string, fallback: DefaultProtocol): AddressFacts {
  const text = input.trim();
  const hostPort = HOST_PORT.test(text) || BRACKETED_HOST.test(text);
  const schemeShaped = SCHEME.test(text);
  const protocolRelative = text.startsWith("//");
  const url = URL.parse(protocolRelative ? `${PROTOCOL[fallback]}${text}` : !hostPort && schemeShaped ? text : `${PROTOCOL[fallback]}//${text}`);
  return {
    text,
    blank: text === "",
    hasControl: UNREADABLE.test(text),
    searchOperator: SEARCH_OPERATOR.test(text),
    hasAt: text.includes("@"),
    hostPort,
    schemeShaped,
    typedScheme: schemeOf(url),
    dottedDomain: DOTTED_DOMAIN.test(text),
    protocolRelative,
    bracketed: text.startsWith("["),
    parses: url !== null,
    userInfo: hasUserInfo(url),
    href: url?.href ?? "",
  };
}

export function parseBrowserAddressInput(input: string, options: { defaultProtocol: "http:" | "https:" }): BrowserAddressInput {
  const fallback: DefaultProtocol = options.defaultProtocol === "http:" ? "DefaultHttp" : "DefaultHttps";
  return browserAddressInput(addressFacts(input, fallback), fallback);
}

export function webAddress(href: string): WebAddress {
  const authority = AUTHORITY.exec(href)?.[1];
  const url = authority === undefined ? null : URL.parse(href);
  return {
    href,
    units: href.length,
    cleanText: !UNREADABLE.test(href) && !WHITESPACE.test(href),
    scheme: schemeOf(url),
    validHost: authority !== undefined && SERVER.test(authority) && url !== null && url.hostname !== "",
    userInfo: authority?.includes("@") === true || hasUserInfo(url),
  };
}

export function isWebAddress(value: unknown): value is string {
  return typeof value === "string" && plainWebAddress(webAddress(value));
}

export function isSecureWebAddress(value: unknown): value is string {
  return typeof value === "string" && secureWebAddress(webAddress(value));
}
