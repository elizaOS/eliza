import type { InteractionError } from "@polyagent/shared";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useInteractionStore } from "@/stores/interactionStore";

/**
 * Hook to display toast notifications for interaction errors.
 *
 * Monitors the error state in the interaction store and automatically displays
 * toast notifications when new errors occur. Prevents duplicate toasts for
 * the same error by tracking previously shown errors.
 *
 * Errors are displayed using Sonner toast notifications with a 4-second duration.
 *
 * @example
 * ```tsx
 * // Simply call the hook - it will automatically show toasts for errors
 * useErrorToasts();
 * ```
 */
export function useErrorToasts() {
  const { errors } = useInteractionStore();
  const prevErrorsRef = useRef<Map<string, InteractionError>>(new Map());

  useEffect(() => {
    // Compare current errors with previous errors
    const currentErrors = new Map(errors);
    const prevErrors = prevErrorsRef.current;

    // Find new errors that weren't in previous state
    currentErrors.forEach((error, key) => {
      const prevError = prevErrors.get(key);
      if (!prevError || prevError.message !== error.message) {
        // Show error toast for new error
        toast.error("Interaction Failed", {
          description: error.message,
          duration: 4000,
        });
      }
    });

    // Update ref with current errors
    prevErrorsRef.current = currentErrors;
  }, [errors]);
}
