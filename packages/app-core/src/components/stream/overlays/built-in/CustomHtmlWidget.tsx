/**
 * CustomHtml — User-provided HTML/CSS/JS or external URL rendered in a
 * sandboxed iframe.
 *
 * ## Security model
 *
 * Both modes use `sandbox="allow-scripts"` WITHOUT `allow-same-origin`.
 * This means the iframe:
 *   - Can execute JavaScript but is treated as a unique opaque origin
 *   - Cannot access the parent frame's DOM, cookies, or localStorage
 *   - Cannot make same-origin requests to the host application
 *   - Cannot navigate the parent frame
 *
 * Inline mode adds a strict CSP meta tag that blocks all network requests
 * (no fetch, XHR, image loads, or script imports from external origins).
 * This confines user-provided JS to pure computation and DOM manipulation.
 *
 * URL mode loads external content with `allow-scripts` only. The content
 * can make network requests to its own origin but cannot interact with
 * the host application. Only use trusted URLs — the iframe will execute
 * whatever JavaScript the remote page serves.
 */

import { useApp } from "@elizaos/app-core/state";
import { useRef } from "react";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

/** CSP that blocks all network access — inline scripts/styles only. */
const INLINE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';";

function CustomHtml({ instance }: WidgetRenderProps) {
  const { t } = useApp();
  const mode = (instance.config.mode as string) ?? "inline";
  const htmlContent = (instance.config.html as string) ?? "";
  const cssContent = (instance.config.css as string) ?? "";
  const jsContent = (instance.config.js as string) ?? "";
  const url = (instance.config.url as string) ?? "";

  const iframeRef = useRef<HTMLIFrameElement>(null);

  if (mode === "url" && url) {
    return (
      <iframe
        ref={iframeRef}
        src={url}
        sandbox="allow-scripts"
        className="w-full h-full border-0 rounded"
        title={t("customhtmlwidget.CustomWidgetExter")}
      />
    );
  }

  // Inline mode: render HTML/CSS/JS via srcdoc with strict CSP
  const srcdoc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${INLINE_CSP}">
<style>${cssContent}</style>
</head>
<body>${htmlContent}<script>${jsContent}</script></body>
</html>`;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcdoc}
      sandbox="allow-scripts"
      className="w-full h-full border-0 rounded"
      title={t("customhtmlwidget.CustomWidgetInlin")}
    />
  );
}

const definition: WidgetDefinition = {
  type: "custom-html",
  name: "Custom HTML",
  description:
    "User-provided HTML/CSS/JS or external URL in a sandboxed iframe",
  subscribesTo: [],
  defaultPosition: { x: 10, y: 10, width: 30, height: 30 },
  defaultZIndex: 20,
  configSchema: {
    mode: {
      type: "select",
      label: "Mode",
      default: "inline",
      options: [
        { label: "Inline HTML", value: "inline" },
        { label: "External URL", value: "url" },
      ],
    },
    html: { type: "string", label: "HTML", default: "" },
    css: { type: "string", label: "CSS", default: "" },
    js: { type: "string", label: "JavaScript", default: "" },
    url: { type: "string", label: "URL", default: "" },
  },
  defaultConfig: { mode: "inline", html: "", css: "", js: "", url: "" },
  render: CustomHtml,
};

registerWidget(definition);
export default definition;
