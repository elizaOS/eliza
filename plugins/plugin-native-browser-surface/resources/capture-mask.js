/** Covers secret fields with opaque boxes before a native screenshot and removes them afterwards. Native hosts evaluate this bundled operation, never caller-supplied JavaScript. Values are never read or returned. */
// biome-ignore lint/correctness/noUnusedVariables: Native hosts evaluate this resource as a function expression.
function captureMask(command) {
  const attribute = "data-eliza-capture-mask";
  try {
    if (!command || typeof command.token !== "string" || !command.token)
      return { error: "A capture mask needs a token." };
    if (command.action === "restore") {
      let removed = 0;
      for (const box of document.querySelectorAll(`[${attribute}]`)) {
        box.remove();
        removed += 1;
      }
      return { removed };
    }
    if (command.action !== "mask")
      return { error: "Unknown capture mask action." };
    // Payment and sign-in secrets as browsers classify them, plus host selectors
    // for values the host itself knows are secret.
    const secret = [
      'input[type="password" i]',
      '[autocomplete~="current-password" i]',
      '[autocomplete~="new-password" i]',
      '[autocomplete~="one-time-code" i]',
      '[autocomplete*="cc-" i]',
    ];
    for (const selector of command.selectors || []) {
      if (typeof selector === "string" && selector.length <= 512)
        secret.push(selector);
    }
    const boxes = [];
    let fields = 0;
    let frames = 0;
    const cover = (rect, offsetX, offsetY) => {
      if (rect.width <= 0 || rect.height <= 0) return;
      boxes.push({
        left: rect.left + offsetX,
        top: rect.top + offsetY,
        width: rect.width,
        height: rect.height,
      });
    };
    const visit = (root, offsetX, offsetY, depth) => {
      for (const selector of secret) {
        let matches;
        try {
          matches = root.querySelectorAll(selector);
        } catch {
          return { error: "A capture mask selector is invalid." };
        }
        for (const element of matches) {
          cover(element.getBoundingClientRect(), offsetX, offsetY);
          fields += 1;
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && depth < 8) {
          const nested = visit(element.shadowRoot, offsetX, offsetY, depth + 1);
          if (nested) return nested;
        }
        if (element.tagName !== "IFRAME" && element.tagName !== "FRAME")
          continue;
        let inner = null;
        try {
          inner = element.contentDocument;
        } catch {
          inner = null;
        }
        const rect = element.getBoundingClientRect();
        if (inner?.documentElement && depth < 8) {
          const nested = visit(
            inner,
            offsetX + rect.left + element.clientLeft,
            offsetY + rect.top + element.clientTop,
            depth + 1,
          );
          if (nested) return nested;
        } else if (command.frames !== false) {
          // A card field from a payment processor usually lives in a frame
          // this page cannot read, so an unreadable frame is covered whole.
          cover(rect, offsetX, offsetY);
          frames += 1;
        }
      }
      return null;
    };
    const failed = visit(document, 0, 0, 0);
    if (failed) return failed;
    // The root element, not body: a transformed body would move fixed boxes.
    const host = document.documentElement;
    const placed = [];
    for (const box of boxes) {
      const element = document.createElement("div");
      element.setAttribute(attribute, command.token);
      element.style.cssText = [
        "position:fixed",
        `left:${box.left}px`,
        `top:${box.top}px`,
        `width:${box.width}px`,
        `height:${box.height}px`,
        "background:#5f6368",
        "z-index:2147483647",
        "pointer-events:none",
        "margin:0",
        "border:0",
        "padding:0",
        "display:block",
        "visibility:visible",
        "opacity:1",
        "transform:none",
      ]
        .map((rule) => `${rule} !important`)
        .join(";");
      host.appendChild(element);
      placed.push([element, box]);
    }
    // A page style that moves or hides a box would expose the field it
    // covers, so a box that is not where it was put fails the whole capture.
    for (const [element, box] of placed) {
      const rect = element.getBoundingClientRect();
      if (
        Math.abs(rect.left - box.left) > 1 ||
        Math.abs(rect.top - box.top) > 1 ||
        rect.width + 1 < box.width ||
        rect.height + 1 < box.height ||
        getComputedStyle(element).display === "none"
      ) {
        for (const [stale] of placed) stale.remove();
        return { error: "A capture mask could not cover a secret field." };
      }
    }
    return { fields, frames, boxes: boxes.length };
  } catch (error) {
    return {
      error: `The capture mask failed: ${error?.name || "error"}`,
    };
  }
}
