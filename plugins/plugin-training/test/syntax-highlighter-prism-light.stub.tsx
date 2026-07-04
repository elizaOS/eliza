/** Test stub for react-syntax-highlighter's Prism light build — renders children in a plain <pre>, no highlighting. */
import React from "react";

function SyntaxHighlighter({ children }: { children?: React.ReactNode }) {
  return React.createElement("pre", {}, children);
}

SyntaxHighlighter.registerLanguage = () => {};

export default SyntaxHighlighter;
export { SyntaxHighlighter };
