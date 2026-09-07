// Bundled native operation, not caller-supplied JavaScript. The only argument
// is a CSS selector. Page text is untrusted data, never a bridge instruction.
(function readPage(selector) {
  try {
    if (document.readyState === "loading") {
      return { error: "The native page is still loading." };
    }
    const root = document.querySelector(selector || "body");
    if (!root) return { error: "No element matches the requested selector." };
    const excluded = "script,style,template,noscript,input,textarea,select,[hidden],[aria-hidden=true]";
    const visible = (element) => {
      if (element.closest(excluded)) return false;
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      }
      return element.getClientRects().length > 0;
    };
    if (!visible(root)) return { error: "The requested element is not readable visible page text." };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = [];
    let length = 0;
    let scanned = 0;
    let truncated = false;
    let node;
    while ((node = walker.nextNode())) {
      if (++scanned > 10000) { truncated = true; break; }
      if (!node.parentElement || !visible(node.parentElement)) continue;
      const text = node.textContent.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const remaining = 16000 - length;
      if (remaining <= 0) { truncated = true; break; }
      parts.push(text.slice(0, remaining));
      length += Math.min(text.length, remaining) + 1;
      if (text.length > remaining) { truncated = true; break; }
    }
    return { url: location.href, title: document.title, text: parts.join("\n"), truncated };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Native page read failed." };
  }
})
