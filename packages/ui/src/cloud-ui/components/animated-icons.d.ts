/**
 * Animated Icons for App Builder
 *
 * Premium animated SVG icons for status indicators.
 * Features smooth CSS animations for a polished AAA feel.
 */
interface AnimatedIconProps {
  className?: string;
  size?: number;
  delay?: number;
}
/**
 * Animated checkmark with drawing effect
 * Circle draws first, then checkmark pops in
 */
export declare function AnimatedCheckmark({
  className,
  size,
  delay,
}: AnimatedIconProps): import("react/jsx-runtime").JSX.Element;
/**
 * Simple checkmark without circle - draws in smoothly
 */
export declare function AnimatedCheck({
  className,
  size,
  delay,
}: AnimatedIconProps): import("react/jsx-runtime").JSX.Element;
/**
 * Animated loading ring with rotating gradient
 */
export declare function AnimatedLoadingRing({
  className,
  size,
}: AnimatedIconProps): import("react/jsx-runtime").JSX.Element;
/**
 * Animated hourglass/timer with sand flowing
 */
export declare function AnimatedHourglass({
  className,
  size,
}: AnimatedIconProps): import("react/jsx-runtime").JSX.Element;
/**
 * Pulsing dots loading indicator
 */
export declare function AnimatedDots({
  className,
  size,
}: AnimatedIconProps): import("react/jsx-runtime").JSX.Element;
/**
 * Spinning gear/cog for processing state
 */
export declare function AnimatedGear({
  className,
  size,
}: AnimatedIconProps): import("react/jsx-runtime").JSX.Element;
/**
 * Circular progress with animated stroke
 */
export declare function AnimatedProgress({
  className,
  size,
  progress,
}: AnimatedIconProps & {
  progress?: number;
}): import("react/jsx-runtime").JSX.Element;
/**
 * Orbiting dots spinner - premium look
 */
export declare function AnimatedOrbit({
  className,
  size,
}: AnimatedIconProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=animated-icons.d.ts.map
