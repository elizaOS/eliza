/** Supports app-core build, packaging, or development orchestration for ios plist url scheme mjs. */
function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function insertBeforeRootPlistDictClose(content, insertion) {
  const rootClose = "\n</dict>\n</plist>";
  const index = content.lastIndexOf(rootClose);
  if (index >= 0) {
    return `${content.slice(0, index)}\n${insertion}${content.slice(index + "\n</dict>".length)}`;
  }
  const fallbackIndex = content.lastIndexOf("</dict>");
  if (fallbackIndex < 0) {
    throw new Error("Info.plist: could not locate top-level </dict>");
  }
  return `${content.slice(0, fallbackIndex)}${insertion}${content.slice(fallbackIndex + "</dict>".length)}`;
}

function findUrlTypesArrayRange(content) {
  const keyIndex = content.indexOf("<key>CFBundleURLTypes</key>");
  if (keyIndex < 0) return null;
  const openMatch = /<array\b[^>]*>/g;
  openMatch.lastIndex = keyIndex;
  const firstOpen = openMatch.exec(content);
  if (!firstOpen) {
    throw new Error("Info.plist: CFBundleURLTypes has no array value");
  }

  const tagRe = /<\/?array\b[^>]*>/g;
  tagRe.lastIndex = firstOpen.index;
  let depth = 0;
  for (let match = tagRe.exec(content); match; match = tagRe.exec(content)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0) return { start: firstOpen.index, close: match.index };
      if (depth < 0) break;
    } else {
      depth += 1;
    }
  }

  throw new Error("Info.plist: CFBundleURLTypes array is not closed");
}

export function ensurePlistUrlScheme(content, urlScheme) {
  const trimmedScheme = String(urlScheme).trim();
  if (!trimmedScheme) {
    throw new Error("Cannot patch iOS Info.plist without a URL scheme");
  }

  const escapedScheme = escapeXmlText(trimmedScheme);
  const entry = `
		<dict>
			<key>CFBundleURLName</key>
			<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>${escapedScheme}</string>
			</array>
		</dict>`;
  const urlTypesArrayRange = findUrlTypesArrayRange(content);
  if (urlTypesArrayRange === null) {
    return insertBeforeRootPlistDictClose(
      content,
      `\t<key>CFBundleURLTypes</key>\n\t<array>${entry}\n\t</array>\n</dict>`,
    );
  }
  const urlTypesContent = content.slice(
    urlTypesArrayRange.start,
    urlTypesArrayRange.close,
  );
  if (urlTypesContent.includes(`<string>${escapedScheme}</string>`)) {
    return content;
  }
  return `${content.slice(0, urlTypesArrayRange.close)}${entry}${content.slice(urlTypesArrayRange.close)}`;
}
