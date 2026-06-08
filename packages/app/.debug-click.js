// Inject this into the WebView console to debug click targeting
(() => {
  const input = document.querySelector(
    '[data-testid="chat-composer-textarea"]',
  );
  if (!input) {
    console.log("DEBUG: input NOT found in DOM");
    return;
  }
  const rect = input.getBoundingClientRect();
  const styles = getComputedStyle(input);
  const parent = input.closest('[data-testid="continuous-chat-overlay"]');
  const parentStyles = parent ? getComputedStyle(parent) : null;

  console.log(
    "DEBUG INPUT:",
    JSON.stringify({
      tagName: input.tagName,
      readOnly: input.readOnly,
      disabled: input.disabled,
      hidden: input.hidden,
      rect: {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        bottom: rect.bottom,
      },
      pointerEvents: styles.pointerEvents,
      userSelect: styles.webkitUserSelect || styles.userSelect,
      visibility: styles.visibility,
      opacity: styles.opacity,
      display: styles.display,
      zIndex: styles.zIndex,
      parentPointerEvents: parentStyles?.pointerEvents,
      parentZIndex: parentStyles?.zIndex,
    }),
  );

  // Check what element is at the input's position
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const elemAtPoint = document.elementFromPoint(centerX, centerY);
  console.log(
    "DEBUG ELEMENT AT POINT:",
    elemAtPoint?.tagName,
    elemAtPoint?.className?.substring(0, 100),
    elemAtPoint?.getAttribute("data-testid"),
  );

  // Try focus
  input.focus();
  console.log(
    "DEBUG: focused, activeElement:",
    document.activeElement?.tagName,
    document.activeElement?.getAttribute("data-testid"),
  );
})();
