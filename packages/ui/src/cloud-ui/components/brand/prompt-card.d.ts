/**
 * Prompt card: flat surface for clickable prompt suggestions.
 */
interface PromptCardProps {
    prompt: string;
    onClick?: () => void;
    className?: string;
}
export declare function PromptCard({ prompt, onClick, className }: PromptCardProps): import("react/jsx-runtime").JSX.Element;
interface PromptCardGridProps {
    prompts: string[];
    onPromptClick?: (prompt: string) => void;
    className?: string;
}
export declare function PromptCardGrid({ prompts, onPromptClick, className, }: PromptCardGridProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=prompt-card.d.ts.map