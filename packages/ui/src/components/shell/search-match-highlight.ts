/** Paints temporary search matches behind rendered text without changing React-owned text nodes. */
export function highlightSearchMatches(
  element: HTMLElement,
  query: string,
): () => void {
  if (!query) return () => {};
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  const text = nodes.map((node) => node.data).join("");
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "giu",
  );
  const ranges: Range[] = [];
  for (const match of text.matchAll(pattern)) {
    const range = document.createRange();
    const start = match.index;
    const end = start + match[0].length;
    let offset = 0;
    let started = false;
    for (const node of nodes) {
      const next = offset + node.length;
      if (!started && start < next) {
        range.setStart(node, start - offset);
        started = true;
      }
      if (started && end <= next) {
        range.setEnd(node, end - offset);
        ranges.push(range);
        break;
      }
      offset = next;
    }
  }
  if (!ranges.length) return () => {};
  const previous = {
    backgroundImage: element.style.backgroundImage,
    backgroundSize: element.style.backgroundSize,
    backgroundPosition: element.style.backgroundPosition,
    backgroundRepeat: element.style.backgroundRepeat,
    backgroundOrigin: element.style.backgroundOrigin,
  };
  const paint = () => {
    const bounds = element.getBoundingClientRect();
    const rectangles = ranges.flatMap((range) =>
      Array.from(range.getClientRects()),
    );
    element.style.backgroundOrigin = "border-box";
    element.style.backgroundImage = rectangles
      .map((rect) => {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><rect width="100%" height="100%" rx="4" fill="white" fill-opacity="0.28"/></svg>`;
        return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
      })
      .join(",");
    element.style.backgroundSize = rectangles
      .map((rect) => `${rect.width}px ${rect.height}px`)
      .join(",");
    element.style.backgroundPosition = rectangles
      .map((rect) => `${rect.left - bounds.left}px ${rect.top - bounds.top}px`)
      .join(",");
    element.style.backgroundRepeat = "no-repeat";
  };
  paint();
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
  observer?.observe(element);
  return () => {
    observer?.disconnect();
    Object.assign(element.style, previous);
  };
}

/** Fit the destination glow to a user bubble or the assistant's rendered text. */
export function highlightSearchMessage(
  bubble: HTMLElement,
  text: HTMLElement,
  isUser: boolean,
): { fade: () => void; clear: () => void } {
  const glow = document.createElement("div");
  glow.setAttribute("aria-hidden", "true");
  Object.assign(glow.style, {
    position: "fixed",
    zIndex: "9001",
    pointerEvents: "none",
    borderRadius: "16px",
    background: "rgba(255,255,255,0.07)",
    boxShadow:
      "0 0 0 1px rgba(255,255,255,0.16), 0 0 14px rgba(255,255,255,0.10)",
    transition: "opacity 450ms ease-out",
  });
  const paint = () => {
    const bounds = bubble.getBoundingClientRect();
    let left = 0,
      top = 0,
      right = bounds.width,
      bottom = bounds.height;
    if (!isUser) {
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      const rects: DOMRect[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(...Array.from(range.getClientRects()));
      }
      if (rects.length) {
        left = Math.min(...rects.map((r) => r.left)) - bounds.left;
        top = Math.min(...rects.map((r) => r.top)) - bounds.top;
        right = Math.max(...rects.map((r) => r.right)) - bounds.left;
        bottom = Math.max(...rects.map((r) => r.bottom)) - bounds.top;
      }
    }
    const space = isUser ? 4 : 8;
    Object.assign(glow.style, {
      left: `${bounds.left + left - space}px`,
      top: `${bounds.top + top - space}px`,
      width: `${right - left + space * 2}px`,
      height: `${bottom - top + space * 2}px`,
    });
  };
  paint();
  document.body.appendChild(glow);
  let frame = 0;
  const track = () => {
    paint();
    frame = requestAnimationFrame(track);
  };
  frame = requestAnimationFrame(track);
  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
  observer?.observe(bubble);
  return {
    fade: () => {
      glow.style.opacity = "0";
    },
    clear: () => {
      observer?.disconnect();
      glow.remove();
      cancelAnimationFrame(frame);
    },
  };
}
