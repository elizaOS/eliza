/**
 * capturePageContext() — snapshots the live DOM (title, visible text, headings,
 * links, forms) so the agent can read the current page. Runs in the
 * content-script context. Whitespace is normalized without shortening admitted
 * content; an oversized complete snapshot is rejected atomically.
 */
import type { PageContextSnapshot } from "./protocol";

export const MAX_PAGE_CONTEXT_UTF8_BYTES = 1_048_576;

function normalizeText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function isVisible(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function collectVisibleText(): string | null {
  if (!document.body) {
    return null;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const parent = textNode.parentElement;
    if (!parent || !isVisible(parent)) {
      continue;
    }
    const nextText = normalizeText(textNode.textContent);
    if (!nextText) {
      continue;
    }
    parts.push(nextText);
  }
  return normalizeText(parts.join(" "));
}

function collectHeadings(): string[] {
  return Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((heading) => normalizeText(heading.textContent))
    .filter((value): value is string => Boolean(value));
}

function collectLinks(): Array<{ text: string; href: string }> {
  return Array.from(document.querySelectorAll("a[href]"))
    .map((link) => ({
      text: normalizeText(link.textContent) ?? "",
      href: link instanceof HTMLAnchorElement ? link.href : "",
    }))
    .filter((link) => link.href.length > 0);
}

function collectForms(): Array<{ action: string | null; fields: string[] }> {
  return Array.from(document.forms).map((form) => {
    const fields = Array.from(form.elements)
      .map((element) => {
        if (
          !(
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          )
        ) {
          return null;
        }
        if (!isVisible(element)) {
          return null;
        }
        if (
          element instanceof HTMLInputElement &&
          (element.type === "password" || element.type === "hidden")
        ) {
          return null;
        }
        return normalizeText(
          element.name || element.id || element.getAttribute("aria-label"),
        );
      })
      .filter((value): value is string => Boolean(value));
    return {
      action: normalizeText(form.action),
      fields,
    };
  });
}

export function capturePageContext(): PageContextSnapshot {
  const snapshot = {
    url: window.location.href,
    title: document.title || window.location.href,
    selectionText: normalizeText(window.getSelection?.()?.toString()),
    mainText: collectVisibleText(),
    headings: collectHeadings(),
    links: collectLinks(),
    forms: collectForms(),
    capturedAt: new Date().toISOString(),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > MAX_PAGE_CONTEXT_UTF8_BYTES) {
    throw new Error(
      `BROWSER_BRIDGE_PAGE_CONTEXT_TOO_LARGE: complete page context contains ${bytes} UTF-8 bytes; maximum admitted size is ${MAX_PAGE_CONTEXT_UTF8_BYTES}`,
    );
  }
  return snapshot;
}
