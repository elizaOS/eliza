// spec/os/browser/surface/commands.md, "Reading needs the shown, loaded page, and a paused page is never driven or observed"
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Native hosts evaluate this resource as a function expression.
function readPage(selector) {
  try {
    if (document.readyState === "loading") {
      return { error: "The native page is still loading." };
    }
    const excluded =
      "script,style,template,noscript,input,textarea,select,[contenteditable=true],[contenteditable=''],[hidden],[aria-hidden=true]";
    const viewOf = (node) => node?.ownerDocument?.defaultView ?? window;
    const styleOf = (element) => viewOf(element).getComputedStyle(element);
    const parentAcrossRoots = (element) => {
      if (element.parentElement) return element.parentElement;
      const root = element.getRootNode?.();
      if (root && root.host) return root.host;
      const frame = element.ownerDocument?.defaultView?.frameElement;
      return frame && frame.nodeType === Node.ELEMENT_NODE ? frame : null;
    };
    const sameOriginDocument = (frame) => {
      try {
        const child = frame.contentDocument;
        return child && child.defaultView?.origin === location.origin
          ? child
          : null;
      } catch {
        return null;
      }
    };
    const visible = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const own = styleOf(element);
      if (own.visibility === "hidden" || own.visibility === "collapse")
        return false;
      for (
        let ancestor = element;
        ancestor;
        ancestor = parentAcrossRoots(ancestor)
      ) {
        if (ancestor.matches && ancestor.matches(excluded)) return false;
        const style = styleOf(ancestor);
        if (style.display === "none" || style.opacity === "0") return false;
      }
      return element.getClientRects().length > 0;
    };
    const resolveRoot = (rawSelector) => {
      if (!rawSelector) return document.body ?? document.documentElement;
      const steps = String(rawSelector)
        .split(" >>> ")
        .map((part) => part.trim())
        .filter(Boolean);
      if (steps.length === 0) return document.body ?? document.documentElement;
      let scope = document;
      let found = null;
      for (let index = 0; index < steps.length; index++) {
        found = scope.querySelector(steps[index]);
        if (!found) return null;
        if (index < steps.length - 1) {
          const next = found.shadowRoot ?? sameOriginDocument(found);
          if (!next) return null;
          scope = next;
        }
      }
      return found;
    };
    const root = resolveRoot(selector);
    if (!root) return { error: "No element matches the requested selector." };
    if (!visible(root))
      return {
        error: "The requested element is not readable visible page text.",
      };
    const parts = [];
    const seen = new WeakSet();
    const collect = (node) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.parentElement || !visible(node.parentElement)) return;
        const text = node.textContent.replace(/\s+/g, " ").trim();
        if (text) parts.push(text);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches(excluded) || node.isContentEditable) return;
      const style = styleOf(node);
      if (style.display === "none" || style.opacity === "0") return;
      if (node.localName === "details" && !node.open) {
        const summary = node.querySelector(":scope > summary");
        if (summary) collect(summary);
        return;
      }
      if (
        (node.localName === "iframe" || node.localName === "frame") &&
        node.namespaceURI === "http://www.w3.org/1999/xhtml"
      ) {
        if (!visible(node)) return;
        const inner = sameOriginDocument(node);
        if (inner) collect(inner.body ?? inner.documentElement);
        return;
      }
      const assigned =
        node.localName === "slot" && node.getRootNode?.()?.host
          ? node.assignedNodes({ flatten: true })
          : [];
      const children = node.shadowRoot
        ? node.shadowRoot.childNodes
        : assigned.length > 0
          ? assigned
          : node.childNodes;
      for (const child of children) collect(child);
    };
    collect(root);
    return {
      url: location.href,
      title: document.title,
      text: parts.join("\n"),
      truncated: false,
    };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Native page read failed.",
    };
  }
}
