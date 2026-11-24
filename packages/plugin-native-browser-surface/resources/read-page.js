// spec/os/browser/surface/commands.md, "Reading needs the shown, loaded page, and a paused page is never driven or observed"
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Native hosts evaluate this resource as a function expression.
function readPage(selector) {
  try {
    if (document.readyState === "loading") {
      return { error: "The native page is still loading." };
    }
    const root = document.querySelector(selector || "body");
    if (!root) return { error: "No element matches the requested selector." };
    const excluded =
      "script,style,template,noscript,input,textarea,select,[hidden],[aria-hidden=true]";
    const visible = (element) => {
      if (element.closest(excluded)) return false;
      const own = getComputedStyle(element);
      if (own.visibility === "hidden" || own.visibility === "collapse")
        return false;
      for (
        let ancestor = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.opacity === "0") return false;
      }
      return element.getClientRects().length > 0;
    };
    if (!visible(root))
      return {
        error: "The requested element is not readable visible page text.",
      };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement || !visible(node.parentElement)) continue;
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (!text) continue;
      parts.push(text);
    }
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
