/**
 * Public page source for the read-aloud and page-question reviews when the
 * live page cannot be read in an isolated world (the web build's sandboxed
 * iframe, or a WebView without document-start scripts). The host fetches the
 * address again WITHOUT credentials, cookies or a referrer, bounded in time and
 * size, and turns HTML into reviewable text. The live frame keeps its opaque
 * origin: nothing here reads the surface itself.
 *
 * A page or excerpt that may hold credentials is reported as `blocked` and the
 * host never offers its text. `undefined` means "nothing to offer" (a network,
 * CORS or type failure), so the review opens empty for pasted text.
 */

import {
  MAX_READING_EXCERPT,
  sensitiveReadingDocument,
  sensitiveReadingText,
  sensitiveReadingUrl,
} from "./page-reading";

export type PageSource =
  | { text: string; truncated: boolean; blocked?: false }
  | { blocked: true };

/** The largest response body the host will decode. */
export const MAX_PAGE_SOURCE_BYTES = 262_144;
/** The longest plain-text body accepted before it is treated as a dump. */
export const MAX_PLAIN_SOURCE_CHARS = 20_000;
export const PAGE_SOURCE_TIMEOUT_MS = 5_000;

export interface PageSourcePorts {
  /** The host's fetch. Defaults to the global one. */
  fetch?: typeof fetch;
  /** Parses untrusted HTML into an inert fragment. Defaults to a `<template>`. */
  parseHtml?: (html: string) => DocumentFragment;
  /** Milliseconds before the fetch is abandoned. */
  timeoutMs?: number;
}

const REMOVED =
  'script,style,noscript,template,iframe,object,embed,svg,form,input,textarea,select,option,button,frame,nav,aside,header,footer,head,[contenteditable]:not([contenteditable="false"]),[role="navigation"],[role="textbox"],[role="button"],[hidden],[inert],[aria-hidden="true"]';
const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|H[1-6]|LI|BR|TR|BLOCKQUOTE|PRE)$/;

function templateParser(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function combinedSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = (source: AbortSignal) => controller.abort(source.reason);
  for (const source of [signal, timeout]) {
    if (source.aborted) {
      abort(source);
      break;
    }
    source.addEventListener("abort", () => abort(source), { once: true });
  }
  return controller.signal;
}

/**
 * Reviewable text from a parsed HTML fragment, or `blocked` when the document
 * looks like a sign-in, recovery or verification page. Chrome, forms and
 * hidden nodes are dropped; the main/article region wins when present.
 */
export function pageSourceText(root: DocumentFragment): PageSource | string {
  if (sensitiveReadingDocument(root)) return { blocked: true };
  for (const node of root.querySelectorAll(REMOVED)) node.remove();
  for (const node of root.querySelectorAll<HTMLElement>("[style]"))
    if (node.style.display === "none" || node.style.visibility === "hidden")
      node.remove();
  const target = root.querySelector('article,main,[role="main"]') ?? root;
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? "");
      return;
    }
    const element =
      node.nodeType === 1 ? (node as Element).tagName.toUpperCase() : "";
    if (BLOCK.test(element)) parts.push("\n");
    for (const child of node.childNodes) walk(child);
    if (element !== "BR" && BLOCK.test(element)) parts.push("\n");
  };
  walk(target);
  return parts.join("");
}

/** Collapses whitespace and bounds the excerpt the review may prefill. */
export function pageSourceExcerpt(source: string): PageSource | undefined {
  const text = source
    .replace(/\r\n?/g, "\n")
    .replace(/[\t \f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) return undefined;
  return {
    text: text.slice(0, MAX_READING_EXCERPT),
    truncated: text.length > MAX_READING_EXCERPT,
  };
}

/**
 * Fetch an HTTP(S) address's public text for review. Aborting `signal` rejects;
 * every other failure resolves to `undefined` (nothing offered) or `blocked`.
 */
export async function readPublicPageSource(
  address: string,
  signal: AbortSignal,
  ports: PageSourcePorts = {},
): Promise<PageSource | undefined> {
  if (sensitiveReadingUrl(address)) return { blocked: true };
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return undefined;
  const fetcher = ports.fetch ?? fetch;
  const parse = ports.parseHtml ?? templateParser;
  const request = combinedSignal(
    signal,
    ports.timeoutMs ?? PAGE_SOURCE_TIMEOUT_MS,
  );
  try {
    const response = await fetcher(url.href, {
      signal: request,
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: { Accept: "text/html,text/plain" },
    });
    const type = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (!response.ok || (type !== "text/html" && type !== "text/plain")) {
      await response.body?.cancel();
      return undefined;
    }
    if (
      Number(response.headers.get("content-length") || 0) >
      MAX_PAGE_SOURCE_BYTES
    ) {
      await response.body?.cancel();
      return { blocked: true };
    }
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let source = "";
    try {
      while (true) {
        request.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > MAX_PAGE_SOURCE_BYTES) return { blocked: true };
        source += decoder.decode(next.value, { stream: true });
      }
      source += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (type === "text/html") {
      const text = pageSourceText(parse(source));
      if (typeof text !== "string") return text;
      source = text;
    } else if (
      source.length > MAX_PLAIN_SOURCE_CHARS ||
      sensitiveReadingText(source)
    )
      return { blocked: true };
    signal.throwIfAborted();
    return pageSourceExcerpt(source);
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}
