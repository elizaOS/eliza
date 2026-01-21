/**
 * UI Utility Functions
 *
 * @description Shared utility functions for UI-related operations, including
 * class name merging for Tailwind CSS.
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names with Tailwind CSS conflict resolution
 *
 * @description Combines class names using clsx and resolves Tailwind CSS conflicts
 * using tailwind-merge. Ensures that conflicting Tailwind classes are properly
 * overridden (e.g., "p-4 p-6" becomes "p-6").
 *
 * @param {...ClassValue} inputs - Class names to merge (strings, arrays, objects)
 * @returns {string} Merged class name string
 *
 * @example
 * ```typescript
 * cn('p-4', 'p-6') // Returns 'p-6'
 * cn('bg-red-500', { 'bg-blue-500': isActive }) // Returns 'bg-blue-500' if isActive
 * ```
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
