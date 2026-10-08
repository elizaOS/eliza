/** Extract HTTP links from chat text without dropping balanced URL delimiters.
 * Fetch owners still validate destinations through their existing SSRF guards.
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(
    /https?:\/\/(?:\[[0-9a-f:.%]+\][^\s<>"'`\]]*|[^\s<>"'`\]]+)/gi,
  );
  if (!matches) return [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const trimmed = stripTrailingPunctuation(raw);
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

function stripTrailingPunctuation(url: string): string {
  let depth = 0;
  let brackets = 0;
  let end = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url[i];
    if (char === "(") depth++;
    else if (char === ")") {
      if (depth === 0) break;
      depth--;
    } else if (char === "[") brackets++;
    else if (char === "]") {
      if (brackets === 0) break;
      brackets--;
    } else if (/[.,;:!?}>*_]/u.test(char)) continue;
    end = i + 1;
  }
  return url.slice(0, end);
}
