/**
 * Platform detection utilities.
 * Determines whether the code is running in a web browser or terminal environment.
 */

/** True when running in a browser (Next.js client-side or any DOM environment). */
export const isWeb: boolean =
  typeof window !== "undefined" && typeof document !== "undefined";

/** True when running in a Node.js / terminal environment (no DOM). */
export const isTerminal: boolean = !isWeb;

/**
 * Returns a value based on the current platform.
 * Useful for conditional rendering where both branches must be valid React.
 */
export function platform<T>(options: { web: T; terminal: T }): T {
  return isWeb ? options.web : options.terminal;
}

/**
 * Window/terminal dimensions hook substitute.
 * In the terminal this maps to process.stdout.columns/rows.
 * In the browser it uses window.innerWidth/innerHeight.
 */
export function getWindowDimensions(): { width: number; height: number } {
  if (!isWeb) {
    return {
      width: (typeof process !== "undefined" && process.stdout?.columns) || 80,
      height: (typeof process !== "undefined" && process.stdout?.rows) || 24,
    };
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}
