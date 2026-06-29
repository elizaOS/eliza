/**
 * Pure iOS Info.plist / project.pbxproj string transformers.
 *
 * Each function takes file content (and options) and returns transformed
 * content — no filesystem or module state. The build spine
 * (`run-mobile-build.mjs`) reads/writes the files and calls these to mutate
 * the text.
 */
import { escapeRegExp, escapeXmlText } from "./escape.mjs";

/** Set (or insert before `</dict>`) a `<key>`/`<string>` pair in a plist. */
export function replaceOrInsertPlistString(content, key, value) {
  const escapedValue = escapeXmlText(value);
  const keyRe = escapeRegExp(key);
  const existingRe = new RegExp(
    `(<key>${keyRe}</key>\\s*<string>)[^<]*(</string>)`,
  );
  if (existingRe.test(content)) {
    return content.replace(existingRe, `$1${escapedValue}$2`);
  }
  return content.replace(
    "</dict>",
    `\t<key>${key}</key>\n\t<string>${escapedValue}</string>\n</dict>`,
  );
}

/** Ensure a plist `<array>` under `key` contains every value in `values`. */
export function ensurePlistArrayStrings(content, key, values) {
  const escapedValues = values.map(escapeXmlText);
  const keyRe = escapeRegExp(key);
  const arrayRe = new RegExp(
    `(<key>${keyRe}</key>\\s*<array>)([\\s\\S]*?)(\\s*</array>)`,
  );
  const match = content.match(arrayRe);
  if (!match) {
    const body = escapedValues
      .map((value) => `\t\t<string>${value}</string>`)
      .join("\n");
    return insertBeforeRootPlistDictClose(
      content,
      `\t<key>${key}</key>\n\t<array>\n${body}\n\t</array>\n</dict>`,
    );
  }
  let body = match[2];
  for (const value of escapedValues) {
    if (!body.includes(`<string>${value}</string>`)) {
      body += `\n\t\t<string>${value}</string>`;
    }
  }
  return content.replace(arrayRe, `$1${body}$3`);
}

/** Insert text immediately before the plist's root `</dict>`. */
export function insertBeforeRootPlistDictClose(content, insertion) {
  const rootClose = "\n</dict>\n</plist>";
  const index = content.lastIndexOf(rootClose);
  if (index >= 0) {
    return `${content.slice(0, index)}\n${insertion}${content.slice(index + "\n</dict>".length)}`;
  }
  const fallbackIndex = content.lastIndexOf("</dict>");
  if (fallbackIndex < 0) return content;
  return `${content.slice(0, fallbackIndex)}${insertion}${content.slice(fallbackIndex + "</dict>".length)}`;
}

/** Rewrite hard-coded `group.<bundle>` app-group ids to the build's app group. */
export function replaceIosAppGroupPlaceholders(content, appGroup) {
  return content.replace(
    /(^|[^A-Za-z0-9_.-])group\.(ai\.elizaos\.app|app\.eliza|com\.elizaai\.eliza)(?![A-Za-z0-9_.-])/g,
    `$1${appGroup}`,
  );
}

/** Remove the named id entries from a pbxproj list section. */
export function removePbxListEntries(content, ids) {
  let next = content;
  for (const id of ids) {
    next = next.replace(
      new RegExp(`\\n\\t+${escapeRegExp(id)} /\\* [^\\n]+ \\*/,`, "g"),
      "",
    );
  }
  return next;
}
