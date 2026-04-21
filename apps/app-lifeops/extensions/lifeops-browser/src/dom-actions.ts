import type { ExecuteDomActionMessage } from "./protocol";

function requireElement(selector?: string | null): HTMLElement {
  if (!selector) {
    throw new Error("selector is required");
  }
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`No HTMLElement found for selector ${selector}`);
  }
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "center", inline: "center" });
  }
  return element;
}

function setElementText(
  element: HTMLElement,
  text: string,
): Record<string, unknown> {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
  ) {
    element.focus();
    element.value = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      selector: element.name || element.id || element.tagName.toLowerCase(),
      valueLength: text.length,
    };
  }
  if (element.isContentEditable) {
    element.focus();
    element.textContent = text;
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: text }),
    );
    return {
      selector: element.id || element.tagName.toLowerCase(),
      valueLength: text.length,
    };
  }
  throw new Error("Target element does not support typing");
}

function submitElement(selector?: string | null): Record<string, unknown> {
  const target = selector ? requireElement(selector) : null;
  const form =
    (target instanceof HTMLFormElement ? target : target?.closest("form")) ??
    document.forms[0] ??
    null;
  if (!form) {
    throw new Error("No form available to submit");
  }
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
  } else {
    form.submit();
  }
  return {
    action: form.action || null,
  };
}

export function runDomAction(
  action: ExecuteDomActionMessage["action"],
): Record<string, unknown> {
  switch (action.kind) {
    case "click": {
      const element = requireElement(action.selector);
      element.click();
      return {
        selector: action.selector ?? null,
        tagName: element.tagName.toLowerCase(),
      };
    }
    case "type": {
      if (typeof action.text !== "string") {
        throw new Error("text is required");
      }
      const element = requireElement(action.selector);
      return setElementText(element, action.text);
    }
    case "submit":
      return submitElement(action.selector);
    case "history_back":
      window.history.back();
      return { direction: "back" };
    case "history_forward":
      window.history.forward();
      return { direction: "forward" };
    default:
      throw new Error(
        `Unsupported DOM action ${(action as { kind: string }).kind}`,
      );
  }
}
