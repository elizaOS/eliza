/**
 * Registers the grammars rendered by cloud code surfaces on the shared Prism
 * highlighter used by native imports and bundled application views.
 */

/// <reference path="../../types/react-syntax-highlighter.d.ts" />

import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash.js";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css.js";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript.js";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json.js";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx.js";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown.js";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup.js";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python.js";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql.js";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx.js";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript.js";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml.js";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light.js";

const registerLanguage = SyntaxHighlighter.registerLanguage;

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

export { SyntaxHighlighter };
