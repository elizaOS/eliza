/**
 * Toast Adapter
 *
 * Provides a toast interface that wraps sonner
 * for compatibility with API Explorer components.
 */

import { toast as sonnerToast } from "sonner";

/**
 * Shows a toast notification.
 *
 * @param options - Toast options.
 * @param options.message - Message to display.
 * @param options.mode - Toast type (success, error, or info).
 * @returns Toast ID for programmatic dismissal.
 */
export const toast = (options: { message: string; mode: "success" | "error" | "info" }) => {
  switch (options.mode) {
    case "success":
      return sonnerToast.success(options.message);
    case "error":
      return sonnerToast.error(options.message);
    case "info":
      return sonnerToast.info(options.message);
  }
};
