/**
 * Suggestions component displaying suggestion buttons in a horizontal scrollable area.
 * Provides clickable suggestion buttons for quick input.
 */
import type { ComponentProps } from "react";
import { Button } from "../button";
import { ScrollArea } from "../scroll-area";
export type SuggestionsProps = ComponentProps<typeof ScrollArea>;
export declare const Suggestions: ({ className, children, ...props }: SuggestionsProps) => import("react/jsx-runtime").JSX.Element;
export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
    suggestion: string;
    onClick?: (suggestion: string) => void;
};
export declare const Suggestion: ({ suggestion, onClick, className, variant, size, children, ...props }: SuggestionProps) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=suggestion.d.ts.map