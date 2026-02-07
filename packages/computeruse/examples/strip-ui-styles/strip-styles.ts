/**
 * Browser script to strip all visual styling from a webpage
 * while keeping HTML structure and JavaScript functionality intact.
 *
 * This creates a "markdown-like" appearance without breaking forms,
 * buttons, inputs, or any interactive elements.
 */

(function() {
  // Store original styles for potential restoration
  (window as any).__originalStyles = (window as any).__originalStyles || null;

  let elementsProcessed = 0;

  // Store original <head> content for restoration
  if (!(window as any).__originalStyles) {
    (window as any).__originalStyles = {
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
    if (el instanceof HTMLElement && el.style.cssText) {
      el.removeAttribute('style');
      elementsProcessed++;
    }
  });

  // 4. Remove class attributes (they reference now-removed CSS)
  allElements.forEach(el => {
    if (el.classList.length > 0) {
      // Keep some functional classes that JS might depend on
      const functionalClasses = [...el.classList].filter(c =>
        c.startsWith('js-') || c.startsWith('data-') || c.includes('active') || c.includes('open') || c.includes('visible')
      );
      el.className = functionalClasses.join(' ');
    }
  });

  // 5. Add minimal base styles for readability
  const baseStyles = document.createElement('style');
  baseStyles.id = 'stripped-base-styles';
  baseStyles.textContent = `
    * {
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace !important;
      font-size: 14px !important;
      line-height: 1.6 !important;
    }

    body {
      background: #fafafa !important;
      color: #333 !important;
      padding: 20px !important;
      max-width: 100% !important;
    }

    a {
      color: #0066cc !important;
      text-decoration: underline !important;
    }

    a:hover {
      color: #004499 !important;
    }

    h1, h2, h3, h4, h5, h6 {
      font-weight: bold !important;
      margin: 1em 0 0.5em 0 !important;
    }

    h1 { font-size: 24px !important; }
    h2 { font-size: 20px !important; }
    h3 { font-size: 18px !important; }
    h4, h5, h6 { font-size: 16px !important; }

    p, div, span, li {
      margin: 0.5em 0 !important;
    }

    input, textarea, select, button {
      border: 1px solid #999 !important;
      padding: 5px 10px !important;
      background: white !important;
      color: #333 !important;
      margin: 2px !important;
    }

    button, input[type="submit"], input[type="button"] {
      cursor: pointer !important;
      background: #eee !important;
    }

    button:hover, input[type="submit"]:hover, input[type="button"]:hover {
      background: #ddd !important;
    }

    img {
      max-width: 100% !important;
      height: auto !important;
      border: 1px solid #ccc !important;
    }

    table {
      border-collapse: collapse !important;
      width: 100% !important;
    }

    td, th {
      border: 1px solid #999 !important;
      padding: 5px !important;
    }

    /* Hide purely decorative elements */
    svg:not([role]), [aria-hidden="true"]:not(input):not(button):not(a) {
      opacity: 0.3 !important;
    }
  `;
  document.head.appendChild(baseStyles);

  return JSON.stringify({
    success: true,
    message: 'Styles stripped successfully. Page is now in minimal/markdown-like mode.',
    elementsProcessed
  });
})();
