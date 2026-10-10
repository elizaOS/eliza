/** Extract HTTP links from chat text without dropping balanced URL delimiters.
 * Fetch owners still validate destinations through their existing SSRF guards.
 */
export function extractUrls(text: string): string[] {
  const matches = text.match(
    // A bracket pair stays in the URL (filter[status]=open); an unmatched "]"
    // ends it, so a Markdown link [https://a/x](https://b/y) still splits. An
    // apostrophe stays only before a word character (Schindler's_List), so a
    // closing quote in code ('https://a/x').then or ['…','…'] ends the URL.
    /https?:\/\/(?:\[[0-9a-f:.%]+\])?(?:[^\s<>"'`[\]]|'(?=\w)|\[[^\s<>"'`[\]]*\])+/gi,
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
      if (depth === 0) {
        if (/[,;]/u.test(url[i + 1] ?? "")) break;
        continue;
      }
      depth--;
    } else if (char === "[") brackets++;
    else if (char === "]") {
      if (brackets === 0) continue;
      brackets--;
    } else if (/[.,;:!?}>*_]/u.test(char)) continue;
    end = i + 1;
  }
  return url.slice(0, end);
}
