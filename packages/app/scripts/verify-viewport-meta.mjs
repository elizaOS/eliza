/**
 * Verifies the emitted app shell preserves the viewport policy for its target.
 * Hosted builds must retain 200% browser zoom; Capacitor builds retain the
 * existing native gesture policy. The check runs after Vite writes dist.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

function viewportContent(html) {
  const viewportTags = (html.match(/<meta\b[^>]*>/gi) ?? []).filter((tag) =>
    /\bname=["']viewport["']/i.test(tag),
  );
  if (viewportTags.length !== 1) {
    throw new Error(
      `expected exactly one viewport meta tag, found ${viewportTags.length}`,
    );
  }
  const content = viewportTags[0].match(/\bcontent=["']([^"']*)["']/i)?.[1];
  if (!content || content.includes("__APP_")) {
    throw new Error(
      "viewport meta content is missing or still contains a token",
    );
  }
  return content;
}

function directives(content) {
  const values = new Map();
  for (const part of content.split(",")) {
    const [name, ...value] = part.trim().toLowerCase().split("=");
    if (!name || values.has(name)) {
      throw new Error(`viewport directive is empty or duplicated: ${name}`);
    }
    values.set(name, value.join("="));
  }
  return values;
}

/** Throws when emitted HTML does not match the target's viewport contract. */
export function assertViewportMetaPolicy(html, capacitorBuildTarget = "") {
  const content = viewportContent(html);
  const values = directives(content);
  if (values.get("width") !== "device-width") {
    throw new Error("viewport width must be device-width");
  }
  if (values.get("initial-scale") !== "1.0") {
    throw new Error("viewport initial-scale must be 1.0");
  }
  if (values.get("viewport-fit") !== "cover") {
    throw new Error("viewport-fit must remain cover");
  }

  const native =
    capacitorBuildTarget === "ios" || capacitorBuildTarget === "android";
  if (native) {
    if (
      values.get("user-scalable") !== "no" ||
      values.get("maximum-scale") !== "1.0"
    ) {
      throw new Error("Capacitor viewport must retain its native zoom policy");
    }
  } else {
    const maximumScale = values.has("maximum-scale")
      ? Number(values.get("maximum-scale"))
      : null;
    if (
      ["no", "0", "false"].includes(values.get("user-scalable")) ||
      (maximumScale !== null &&
        (!Number.isFinite(maximumScale) || maximumScale < 2))
    ) {
      throw new Error(
        "hosted viewport must allow user-agent zoom to at least 200%",
      );
    }
  }
  return content;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  const appDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const html = fs.readFileSync(path.join(appDir, "dist", "index.html"), "utf8");
  const target = process.env.ELIZA_CAPACITOR_BUILD_TARGET ?? "";
  const content = assertViewportMetaPolicy(html, target);
  console.log(
    `[verify-viewport-meta] ${target || "web"} policy verified: ${content}`,
  );
}
