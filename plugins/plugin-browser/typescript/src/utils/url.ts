/**
 * URL extraction and parsing utilities
 */

/**
 * Extract URL from text message
 */
export function extractUrl(text: string): string | null {
  // Check for quoted URL first
  const quotedUrlMatch = text.match(/["']([^"']+)["']/);
  if (quotedUrlMatch && (quotedUrlMatch[1].startsWith("http") || quotedUrlMatch[1].includes("."))) {
    return quotedUrlMatch[1];
  }

  // Check for explicit URL
  const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) {
    return urlMatch[1];
  }

  // Check for domain after navigation keywords
  const domainMatch = text.match(
    /(?:go to|navigate to|open|visit)\s+([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,})/i
  );
  if (domainMatch) {
    return `https://${domainMatch[1]}`;
  }

  return null;
}

/**
 * Parse click target from message
 */
export function parseClickTarget(text: string): string {
  const match = text.match(/click (?:on |the )?(.+)$/i);
  return match ? match[1] : "element";
}

/**
 * Parse type action from message
 */
export function parseTypeAction(text: string): { text: string; field: string } {
  const textMatch = text.match(/["']([^"']+)["']/);
  const textToType = textMatch ? textMatch[1] : "";

  const fieldMatch = text.match(/(?:in|into) (?:the )?(.+)$/i);
  const field = fieldMatch ? fieldMatch[1] : "input field";

  return { text: textToType, field };
}

/**
 * Parse select action from message
 */
export function parseSelectAction(text: string): { option: string; dropdown: string } {
  const optionMatch = text.match(/["']([^"']+)["']/);
  const option = optionMatch ? optionMatch[1] : "";

  const dropdownMatch = text.match(/from (?:the )?(.+)$/i);
  const dropdown = dropdownMatch ? dropdownMatch[1] : "dropdown";

  return { option, dropdown };
}

/**
 * Parse extract instruction from message
 */
export function parseExtractInstruction(text: string): string {
  const match = text.match(/(?:extract|get|find|scrape|read) (?:the )?(.+?)(?:\s+from|\s*$)/i);
  return match ? match[1] : text;
}
