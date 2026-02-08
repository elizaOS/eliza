/**
 * Browser script to strip all visual styling from a webpage
 * while keeping HTML structure and JavaScript functionality intact.
 *
 * This creates a "markdown-like" appearance without breaking forms,
 * buttons, inputs, or any interactive elements.
 */

(function() {
  // Store original styles for potential restoration
  window.__originalStyles = window.__originalStyles || null;

  let elementsProcessed = 0;

  // Store original <head> content for restoration
  if (!window.__originalStyles) {
    window.__originalStyles = {
      headHTML: document.head.innerHTML,
      bodyClassList: [...document.body.classList],
      bodyStyle: document.body.getAttribute('style') || '',
    };
  }

  // 1. Remove all <style> tags
  const styleTags = document.querySelectorAll('style');
  styleTags.forEach(tag => tag.remove());
  elementsProcessed += styleTags.length;

  // 2. Remove all <link rel="stylesheet"> tags
  const linkTags = document.querySelectorAll('link[rel="stylesheet"]');
  linkTags.forEach(tag => tag.remove());
  elementsProcessed += linkTags.length;

  // 3. Remove inline styles from all elements
  const allElements = document.querySelectorAll('*');
  allElements.forEach(el => {
    if (el.style && el.style.cssText) {
      el.removeAttribute('style');
      elementsProcessed++;
    }
  });

  // 4. KEEP class attributes - JS event handlers depend on them
  // We only strip CSS, not the class names themselves

  // 4.5. REMOVE media embeds from DOM entirely (CSS can't reach shadow DOM)
  const mediaSelectors = [
    'iframe', 'canvas', 'video', 'audio', 'embed', 'object',
    'shreddit-embed', 'shreddit-player', 'shreddit-media', 'shreddit-async-loader',
    'faceplate-partial', 'faceplate-tracker',
    '[data-testid*="embed"]', '[data-testid*="player"]', '[data-testid*="media"]',
    '[class*="embed"]', '[class*="player"]', '[class*="Player"]'
  ];
  mediaSelectors.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      el.remove();
      elementsProcessed++;
    });
  });

  // 4.6. Find and remove elements with shadow roots containing canvas/media
  document.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) {
      const hasMedia = el.shadowRoot.querySelector('canvas, video, iframe, [class*="game"], [class*="play"]');
      if (hasMedia) {
        el.remove();
        elementsProcessed++;
      }
    }
  });

  // 4.7. Remove large fixed-size containers (likely embeds) - anything over 300px tall with no text
  document.querySelectorAll('div, section, article').forEach(el => {
    const rect = el.getBoundingClientRect();
    const text = el.innerText?.trim() || '';
    if (rect.height > 300 && text.length < 50) {
      el.remove();
      elementsProcessed++;
    }
  });

  // 5. Add dense markdown-like styles (functional but compact)
  const baseStyles = document.createElement('style');
  baseStyles.id = 'stripped-base-styles';
  baseStyles.textContent = `
    /* Base reset - keep structure, remove decoration */
    * {
      font-family: 'Consolas', monospace !important;
      font-size: 12px !important;
      font-weight: normal !important;
      line-height: 1.3 !important;
      color: #222 !important;
      background: transparent !important;
      background-image: none !important;
      border: none !important;
      box-shadow: none !important;
      text-shadow: none !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    html, body {
      background: #fafafa !important;
      padding: 5px !important;
    }

    /* Block elements - keep block but tight */
    div, p, section, article, header, footer, main, nav, aside, ul, ol, form, fieldset {
      display: block !important;
      margin-bottom: 2px !important;
    }

    li { display: list-item !important; margin-left: 15px !important; }
    li::marker { content: '- '; }

    /* Inline elements */
    span, a, strong, em, b, i, label, small, code { display: inline !important; }
    a { color: #06c !important; text-decoration: underline !important; }
    strong, b { font-weight: bold !important; }
    em, i { font-style: italic !important; }

    /* Headings */
    h1, h2, h3, h4, h5, h6 { display: block !important; margin: 3px 0 1px 0 !important; }
    h1::before { content: '# '; }
    h2::before { content: '## '; }
    h3::before { content: '### '; }

    /* Form elements - functional and visible */
    input, textarea, select {
      display: inline-block !important;
      border: 1px solid #666 !important;
      padding: 1px 3px !important;
      background: #fff !important;
      min-width: 50px !important;
    }
    textarea { display: block !important; width: 100% !important; min-height: 40px !important; }

    button, input[type="submit"], input[type="button"] {
      display: inline-block !important;
      border: 1px solid #666 !important;
      padding: 1px 5px !important;
      background: #ddd !important;
      cursor: pointer !important;
    }

    /* Images - small inline */
    img { max-width: 1.5em !important; max-height: 1.5em !important; display: inline !important; vertical-align: middle !important; }

    /* Hide ALL media embeds aggressively */
    iframe, canvas, video, audio, embed, object,
    [class*="embed"], [class*="player"], [class*="media"], [class*="game"],
    shreddit-embed, shreddit-player, shreddit-media,
    faceplate-partial, faceplate-tracker {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      max-width: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }

    /* Tables */
    table { display: table !important; border-collapse: collapse !important; margin: 2px 0 !important; }
    tr { display: table-row !important; }
    td, th { display: table-cell !important; border: 1px solid #888 !important; padding: 1px 3px !important; }

    /* Hide non-content elements */
    script, style, noscript, template, [hidden], svg,
    [aria-hidden="true"], [role="presentation"], [role="img"],
    hr { display: none !important; }

    /* Pre/code blocks */
    pre, code { background: #eee !important; padding: 1px 2px !important; }
    pre { display: block !important; overflow-x: auto !important; }
  `;
  document.head.appendChild(baseStyles);

  return JSON.stringify({
    success: true,
    message: 'Styles stripped successfully. Page is now in minimal/markdown-like mode.',
    elementsProcessed: elementsProcessed
  });
})();
