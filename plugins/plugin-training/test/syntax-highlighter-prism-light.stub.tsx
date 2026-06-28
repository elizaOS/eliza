import React from "react";

function SyntaxHighlighter({ children }: { children?: React.ReactNode }) {
  return React.createElement("pre", {}, children);
}

SyntaxHighlighter.registerLanguage = () => {};

export default SyntaxHighlighter;
export { SyntaxHighlighter };
