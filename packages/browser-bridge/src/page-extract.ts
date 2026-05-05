function normalizeText(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLength);
}

function isVisible(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0"
  );
}

function collectVisibleText(maxLength: number): string | null {
  if (!document.body) {
    return null;
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let currentLength = 0;
  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    const parent = textNode.parentElement;
    if (!parent || !isVisible(parent)) {
      continue;
    }
    const nextText = normalizeText(textNode.textContent, 500);
    if (!nextText) {
      continue;
    }
    parts.push(nextText);
    currentLength += nextText.length + 1;
    if (currentLength >= maxLength) {
      break;
    }
  }
  return normalizeText(parts.join(" "), maxLength);
}

function collectHeadings(): string[] {
  return Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((heading) => normalizeText(heading.textContent, 200))
    .filter((value): value is string => Boolean(value))
    .slice(0, 12);
}

function collectLinks(): Array<{ text: string; href: string }> {
  return Array.from(document.querySelectorAll("a[href]"))
    .map((link) => ({
      text: normalizeText(link.textContent, 160) ?? "",
      href: link instanceof HTMLAnchorElement ? link.href : "",
    }))
    .filter((link) => link.href.length > 0)
    .slice(0, 40);
}

function collectForms(): Array<{ action: string | null; fields: string[] }> {
  return Array.from(document.forms)
    .map((form) => {
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
          if (
            element instanceof HTMLInputElement &&
            (element.type === "password" || element.type === "hidden")
          ) {
            return null;
          }
          return normalizeText(
            element.name || element.id || element.getAttribute("aria-label"),
            120,
          );
        })
        .filter((value): value is string => Boolean(value));
      return {
        action: normalizeText(form.action, 500),
        fields: fields.slice(0, 20),
      };
    })
    .slice(0, 10);
}

export function capturePageContext(): {
  url: string;
  title: string;
  selectionText: string | null;
  mainText: string | null;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  forms: Array<{ action: string | null; fields: string[] }>;
  capturedAt: string;
} {
  return {
    url: window.location.href,
    title: document.title || window.location.href,
    selectionText: normalizeText(window.getSelection?.()?.toString(), 2000),
    mainText: collectVisibleText(12000),
    headings: collectHeadings(),
    links: collectLinks(),
    forms: collectForms(),
    capturedAt: new Date().toISOString(),
  };
}
