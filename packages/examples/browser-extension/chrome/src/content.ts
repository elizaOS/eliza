/**
 * Content Script for Page Content Extraction
 *
 * Extracts clean, meaningful content from web pages with:
 * - Selection detection
 * - Viewport tracking
 * - Ad/nav filtering
 * - Screenshot capability
 */

import type { PageContent } from "../../shared/types";

// ============================================
// Content Filtering Configuration
// ============================================

const EXCLUDED_TAGS = new Set([
  "script", "style", "noscript", "iframe", "svg", "canvas",
  "video", "audio", "source", "track", "map", "area",
  "template", "slot", "portal"
]);

const EXCLUDED_ROLES = new Set([
  "navigation", "banner", "contentinfo", "complementary",
  "search", "form", "menu", "menubar", "toolbar", "status",
  "alert", "alertdialog", "dialog", "tooltip"
]);

const EXCLUDED_CLASSES = [
  /\bad(vert|s|vertisement)?\b/i,
  /\bsponsor(ed)?\b/i,
  /\bpromo(tion)?\b/i,
  /\bsidebar\b/i,
  /\bnav(igation)?\b/i,
  /\bbreadcrumb\b/i,
  /\brelated(-posts)?\b/i,
  /\bwidget\b/i,
  /\bpopup\b/i,
  /\bmodal\b/i,
  /\boverlay\b/i,
  /\bcookie\b/i,
  /\bconsent\b/i,
  /\btoast\b/i,
  // Note: Removed 'header', 'footer', 'menu', 'share', 'social', 'banner', 'notice', 'comment' 
  // because they filter out too much on social media sites like Twitter/X
];

const CONTENT_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "article", "section", "main", "blockquote",
  "li", "td", "th", "figcaption", "caption",
  "pre", "code", "dd", "dt"
]);

// ============================================
// Utility Functions
// ============================================

function shouldExcludeElement(element: Element): boolean {
  const tagName = element.tagName.toLowerCase();
  
  // Check tag name
  if (EXCLUDED_TAGS.has(tagName)) return true;
  
  // Check role
  const role = element.getAttribute("role");
  if (role && EXCLUDED_ROLES.has(role)) return true;
  
  // Check aria-hidden
  if (element.getAttribute("aria-hidden") === "true") return true;
  
  // Check class names
  const className = element.className;
  if (typeof className === "string" && className) {
    for (const pattern of EXCLUDED_CLASSES) {
      if (pattern.test(className)) return true;
    }
  }
  
  // Check id
  const id = element.id;
  if (id) {
    for (const pattern of EXCLUDED_CLASSES) {
      if (pattern.test(id)) return true;
    }
  }
  
  // Check if element is hidden
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return true;
  
  return false;
}

function getTextFromElement(element: Element, depth = 0): string {
  if (depth > 50) return ""; // Prevent infinite recursion
  if (shouldExcludeElement(element)) return "";
  
  const tagName = element.tagName.toLowerCase();
  const texts: string[] = [];
  
  // Process child nodes
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent?.trim();
      if (text) texts.push(text);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childText = getTextFromElement(child as Element, depth + 1);
      if (childText) texts.push(childText);
    }
  }
  
  const content = texts.join(" ").trim();
  if (!content) return "";
  
  // Add semantic markers for headings
  if (tagName.match(/^h[1-6]$/)) {
    return `\n\n## ${content}\n`;
  }
  
  // Add paragraph breaks
  if (tagName === "p" || tagName === "div") {
    return `\n${content}\n`;
  }
  
  // List items
  if (tagName === "li") {
    return `• ${content}\n`;
  }
  
  return content;
}

function isElementInViewport(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

function getViewportRange(): { start: number; end: number } {
  return {
    start: window.scrollY,
    end: window.scrollY + window.innerHeight
  };
}

// ============================================
// Main Extraction Functions
// ============================================

interface ExtractedContent {
  fullText: string;
  visibleText: string;
  viewportStart: number;
  viewportEnd: number;
  totalLength: number;
}

function extractPageContent(): ExtractedContent {
  console.log("[Content Script] Extracting page content...");
  
  // Detect site type for better extraction
  const isTwitter = window.location.hostname.includes("x.com") || window.location.hostname.includes("twitter.com");
  
  // Find the main content area - with site-specific selectors
  let mainElement: Element | null = null;
  
  if (isTwitter) {
    // Twitter/X specific: Find the timeline or main content
    mainElement = 
      document.querySelector("[data-testid='primaryColumn']") ||
      document.querySelector("main[role='main']") ||
      document.querySelector("main");
  }
  
  // Fallback to generic selectors
  if (!mainElement) {
    mainElement =
      document.querySelector("article") ||
      document.querySelector("main") ||
      document.querySelector("[role='main']") ||
      document.querySelector(".main-content") ||
      document.querySelector("#main-content") ||
      document.querySelector(".content") ||
      document.querySelector("#content") ||
      document.body;
  }
  
  console.log("[Content Script] Found main element:", mainElement?.tagName, mainElement?.className);

  // Extract all text content
  let fullText = getTextFromElement(mainElement)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
    
  // If we got very little content, try a more aggressive approach
  if (fullText.length < 200) {
    console.log("[Content Script] Low content, trying fallback extraction...");
    // Fallback: Get all visible text from the body
    const allText = document.body.innerText || "";
    fullText = allText
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+/g, " ")
      .trim();
  }
  
  console.log("[Content Script] Extracted text length:", fullText.length);

  // Track visible content - expand selectors for social media
  const visibleElements: string[] = [];
  const selectors = isTwitter 
    ? "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, span[data-testid], div[data-testid='tweetText'], [lang]"
    : "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre";
  const contentElements = mainElement.querySelectorAll(selectors);
  
  contentElements.forEach((el) => {
    if (isElementInViewport(el)) {
      const text = el.textContent?.trim();
      // Filter out very short text and UI elements
      if (text && text.length > 3 && !text.match(/^[\d\s,.\-:]+$/)) {
        visibleElements.push(text);
      }
    }
  });

  // Deduplicate visible elements
  const uniqueVisible = [...new Set(visibleElements)];
  const visibleText = uniqueVisible.join("\n").trim();
  const viewport = getViewportRange();
  
  console.log("[Content Script] Visible elements:", uniqueVisible.length, "Visible text length:", visibleText.length);

  return {
    fullText,
    visibleText,
    viewportStart: viewport.start,
    viewportEnd: viewport.end,
    totalLength: fullText.length,
  };
}

function getSelectedText(): string {
  const selection = window.getSelection();
  return selection?.toString().trim() || "";
}

// Smart cropping to fit token limit (~100k tokens ≈ 400k chars)
function cropToTokenLimit(
  content: ExtractedContent,
  maxChars = 400000
): string {
  const { fullText, visibleText, viewportStart, viewportEnd, totalLength } = content;
  
  if (fullText.length <= maxChars) {
    // Add viewport markers if content fits
    if (visibleText) {
      const visibleIndex = fullText.indexOf(visibleText.substring(0, 100));
      if (visibleIndex >= 0) {
        return (
          fullText.substring(0, visibleIndex) +
          "\n--- CURRENTLY VISIBLE ON SCREEN START ---\n" +
          fullText.substring(visibleIndex, visibleIndex + visibleText.length) +
          "\n--- CURRENTLY VISIBLE ON SCREEN END ---\n" +
          fullText.substring(visibleIndex + visibleText.length)
        );
      }
    }
    return fullText;
  }

  // Content too large - crop with focus on visible area
  const paddingChars = Math.floor((maxChars - visibleText.length) / 2);
  
  // Find visible text position in full text
  const visibleIndex = fullText.indexOf(visibleText.substring(0, 100));
  if (visibleIndex < 0) {
    // Can't find visible text, just take first chunk
    return fullText.substring(0, maxChars) + "\n\n[Content truncated...]";
  }

  const startIndex = Math.max(0, visibleIndex - paddingChars);
  const endIndex = Math.min(fullText.length, visibleIndex + visibleText.length + paddingChars);
  
  let cropped = "";
  if (startIndex > 0) {
    cropped += "[Content before viewport truncated...]\n\n";
  }
  
  cropped += fullText.substring(startIndex, visibleIndex);
  cropped += "\n--- CURRENTLY VISIBLE ON SCREEN START ---\n";
  cropped += fullText.substring(visibleIndex, Math.min(visibleIndex + visibleText.length, endIndex));
  cropped += "\n--- CURRENTLY VISIBLE ON SCREEN END ---\n";
  cropped += fullText.substring(visibleIndex + visibleText.length, endIndex);
  
  if (endIndex < fullText.length) {
    cropped += "\n\n[Content after viewport truncated...]";
  }

  return cropped;
}

// Screenshot capture
async function captureScreenshot(): Promise<string | null> {
  try {
    // Request screenshot from background script
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          console.error("[Content] Screenshot capture failed:", chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(response.dataUrl);
        }
      });
    });
  } catch (error) {
    console.error("[Content] Screenshot error:", error);
    return null;
  }
}

// ============================================
// Message Handlers
// ============================================

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  try {
    switch (request.type) {
      case "GET_PAGE_CONTENT": {
        const extracted = extractPageContent();
        const selectedText = getSelectedText();
        const croppedContent = cropToTokenLimit(extracted);
        
        const content: PageContent = {
          title: document.title || "Untitled",
          url: window.location.href,
          content: croppedContent,
          selectedText: selectedText || undefined,
          visibleText: extracted.visibleText || undefined,
          extractedAt: Date.now(),
        };
        
        sendResponse({ type: "PAGE_CONTENT_RESPONSE", content });
        break;
      }
      
      case "GET_SELECTED_TEXT": {
        const selectedText = getSelectedText();
        sendResponse({ type: "SELECTED_TEXT_RESPONSE", selectedText });
        break;
      }
      
      case "GET_VISIBLE_TEXT": {
        const extracted = extractPageContent();
        sendResponse({ type: "VISIBLE_TEXT_RESPONSE", visibleText: extracted.visibleText });
        break;
      }
      
      case "CAPTURE_VISIBLE_TAB": {
        // This is handled by background script
        sendResponse({ type: "ERROR", error: "Use background script for screenshots" });
        break;
      }
    }
  } catch (error) {
    console.error("[ElizaOS Content Script] Error:", error);
    sendResponse({
      type: "ERROR",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
  return true;
});

// ============================================
// Initialize
// ============================================

console.log("[ElizaOS Content Script] Loaded on:", window.location.href);

// Notify background script that content script is ready
chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_READY", url: window.location.href });
