/**
 * Animated counter component for smooth number counting animations.
 * Used for displaying earnings, balances, and other numeric values with visual flair.
 */
interface AnimatedCounterProps {
    value: number;
    prefix?: string;
    suffix?: string;
    decimals?: number;
    duration?: number;
    className?: string;
    onComplete?: () => void;
}
export declare function AnimatedCounter({ value, prefix, suffix, decimals, duration, className, onComplete, }: AnimatedCounterProps): import("react/jsx-runtime").JSX.Element;
interface AnimatedCounterWithLabelProps extends AnimatedCounterProps {
    label: string;
    labelClassName?: string;
    valueClassName?: string;
    trend?: {
        value: number;
        period: string;
    };
}
export declare function AnimatedCounterWithLabel({ label, labelClassName, valueClassName, trend, ...counterProps }: AnimatedCounterWithLabelProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=animated-counter.d.ts.map