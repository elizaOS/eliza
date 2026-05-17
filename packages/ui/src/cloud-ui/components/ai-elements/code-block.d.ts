import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Button } from "../button";
/**
 * Code block component with syntax highlighting and copy functionality.
 * Supports light/dark themes and optional line numbers.
 *
 * @param props.code - Source code to display
 * @param props.language - Programming language for syntax highlighting
 * @param props.showLineNumbers - Whether to display line numbers
 * @param props.children - Optional child components (e.g., copy button)
 */
export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
    code: string;
    language: string;
    showLineNumbers?: boolean;
    children?: ReactNode;
};
export declare const CodeBlock: ({ code, language, showLineNumbers, className, children, ...props }: CodeBlockProps) => import("react/jsx-runtime").JSX.Element;
export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
    onCopy?: () => void;
    onError?: (error: Error) => void;
    timeout?: number;
};
export declare const CodeBlockCopyButton: ({ onCopy, onError, timeout, children, className, ...props }: CodeBlockCopyButtonProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=code-block.d.ts.map