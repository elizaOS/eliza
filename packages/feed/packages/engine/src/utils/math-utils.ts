/**
 * Math Utilities
 *
 * Common mathematical operations used throughout the engine.
 * Consolidates duplicate patterns like clamping, rounding, etc.
 */

/**
 * Clamp a number to a range [min, max].
 * Replaces the common pattern: `Math.max(min, Math.min(max, value))`
 *
 * @param value - The value to clamp
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns The clamped value
 *
 * @example
 * ```typescript
 * clamp(150, 0, 100); // 100
 * clamp(-10, 0, 100); // 0
 * clamp(50, 0, 100);  // 50
 * ```
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp a value to [0, 1] range.
 * Common for normalized values, percentages, and probabilities.
 *
 * @param value - The value to clamp
 * @returns Value clamped to [0, 1]
 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Clamp a value to [0, 100] range.
 * Common for percentage values.
 *
 * @param value - The value to clamp
 * @returns Value clamped to [0, 100]
 */
export function clampPercent(value: number): number {
  return clamp(value, 0, 100);
}

/**
 * Clamp a sentiment value to [-1, 1] range.
 * Standard range for sentiment scores.
 *
 * @param value - The sentiment value to clamp
 * @returns Sentiment clamped to [-1, 1]
 */
export function clampSentiment(value: number): number {
  return clamp(value, -1, 1);
}

/**
 * Linear interpolation between two values.
 *
 * @param a - Start value
 * @param b - End value
 * @param t - Interpolation factor [0, 1]
 * @returns Interpolated value
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

/**
 * Round a number to a specified number of decimal places.
 *
 * @param value - The value to round
 * @param decimals - Number of decimal places (default: 2). Must be a non-negative integer.
 * @returns Rounded value
 * @throws RangeError if decimals is negative or not an integer
 *
 * @example
 * ```typescript
 * roundTo(3.14159, 2); // 3.14
 * roundTo(3.14159, 0); // 3
 * ```
 */
export function roundTo(value: number, decimals = 2): number {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(
      `decimals must be a non-negative integer, got ${decimals}`,
    );
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Calculate percentage change between two values.
 *
 * When original is 0:
 * - Returns 0 if current is also 0 (no change from zero to zero)
 * - Returns 100 if current is non-zero (arbitrary sentinel indicating "from zero")
 *
 * Note: The 100 return value for original === 0 && current !== 0 is a convention,
 * not a mathematically meaningful percentage. Callers should handle this case
 * explicitly if they need different semantics (e.g., Infinity or NaN).
 *
 * @param original - Original value
 * @param current - Current value
 * @returns Percentage change (e.g., 50 for 50% increase), or sentinel values when original is 0
 */
export function percentChange(original: number, current: number): number {
  if (original === 0) return current === 0 ? 0 : 100;
  return ((current - original) / Math.abs(original)) * 100;
}

/**
 * Normalize a value from one range to another.
 *
 * By default, if value is outside [fromMin, fromMax], the result will extrapolate
 * beyond [toMin, toMax]. Set clamp = true to constrain the result to [toMin, toMax].
 *
 * @param value - Value to normalize
 * @param fromMin - Original range minimum
 * @param fromMax - Original range maximum
 * @param toMin - Target range minimum (default: 0)
 * @param toMax - Target range maximum (default: 1)
 * @param shouldClamp - If true, clamp the result to [toMin, toMax] (default: false)
 * @returns Normalized value in target range (or clamped if shouldClamp is true)
 */
export function normalize(
  value: number,
  fromMin: number,
  fromMax: number,
  toMin = 0,
  toMax = 1,
  shouldClamp = false,
): number {
  if (fromMax === fromMin) return toMin;
  let ratio = (value - fromMin) / (fromMax - fromMin);
  if (shouldClamp) {
    ratio = clamp01(ratio);
  }
  return toMin + ratio * (toMax - toMin);
}

/**
 * Check if a value is within a range (inclusive).
 *
 * @param value - Value to check
 * @param min - Minimum (inclusive)
 * @param max - Maximum (inclusive)
 * @returns True if value is in range
 */
export function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/**
 * Safe division that returns 0 when dividing by zero.
 *
 * @param numerator - The numerator
 * @param denominator - The denominator
 * @param fallback - Value to return if dividing by zero (default: 0)
 * @returns Result of division or fallback
 */
export function safeDivide(
  numerator: number,
  denominator: number,
  fallback = 0,
): number {
  return denominator === 0 ? fallback : numerator / denominator;
}
