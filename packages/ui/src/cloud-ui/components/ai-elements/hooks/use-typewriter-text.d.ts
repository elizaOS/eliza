interface TypewriterConfig {
    charsPerFrame?: number;
    frameDelay?: number;
    onReveal?: () => void;
}
export declare function useTypewriterText(targetText: string, isActive: boolean, config?: Pick<TypewriterConfig, "onReveal">): string;
export declare function useReasoningTypewriter(targetText: string, isActive: boolean, onReveal?: () => void): string;
export {};
//# sourceMappingURL=use-typewriter-text.d.ts.map