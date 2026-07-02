/**
 * Toast adapter for the API Explorer surface. Wraps `sonner` with the
 * `{ message, mode }` shape the explorer components expect.
 */

import { toast as sonnerToast } from "sonner";

export function toast(options: {
  message: string;
  mode: "success" | "error" | "info";
}) {
  switch (options.mode) {
    case "success":
      return sonnerToast.success(options.message);
    case "error":
      return sonnerToast.error(options.message);
    case "info":
      return sonnerToast.info(options.message);
  }
}
