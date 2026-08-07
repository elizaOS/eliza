/**
 * Provides the cloud code surfaces with a Prism build containing only the
 * grammars those surfaces render, keeping the browser chunk bounded.
 */

/// <reference path="../../types/react-syntax-highlighter.d.ts" />

import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import * as PrismLightModule from "react-syntax-highlighter/dist/esm/prism-light";

const SyntaxHighlighter =
  "default" in PrismLightModule ? PrismLightModule.default : PrismLightModule;

const registerLanguage = SyntaxHighlighter.registerLanguage;

if (typeof registerLanguage === "function") {
  registerLanguage("bash", bash);
  registerLanguage("shell", bash);
  registerLanguage("sh", bash);
  registerLanguage("css", css);
  registerLanguage("javascript", javascript);
  registerLanguage("js", javascript);
  registerLanguage("json", json);
  registerLanguage("jsx", jsx);
  registerLanguage("markdown", markdown);
  registerLanguage("md", markdown);
  registerLanguage("markup", markup);
  registerLanguage("html", markup);
  registerLanguage("xml", markup);
  registerLanguage("python", python);
  registerLanguage("py", python);
  registerLanguage("sql", sql);
  registerLanguage("tsx", tsx);
  registerLanguage("typescript", typescript);
  registerLanguage("ts", typescript);
  registerLanguage("yaml", yaml);
  registerLanguage("yml", yaml);
}

export { SyntaxHighlighter };
