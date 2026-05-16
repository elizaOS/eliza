declare module "react-syntax-highlighter" {
  import type { ComponentType, CSSProperties, ReactNode } from "react";

  export type SyntaxHighlighterStyle = Record<string, CSSProperties>;

  export type SyntaxHighlighterProps = {
    children?: ReactNode;
    className?: string;
    codeTagProps?: Record<string, unknown>;
    customStyle?: CSSProperties;
    language?: string;
    lineNumberStyle?: CSSProperties;
    PreTag?: string;
    showLineNumbers?: boolean;
    style?: SyntaxHighlighterStyle;
    wrapLongLines?: boolean;
  };

  export const Prism: ComponentType<SyntaxHighlighterProps>;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism/index.js" {
  import type { SyntaxHighlighterStyle } from "react-syntax-highlighter";

  export const oneDark: SyntaxHighlighterStyle;
  export const oneLight: SyntaxHighlighterStyle;
  export const vscDarkPlus: SyntaxHighlighterStyle;
}
