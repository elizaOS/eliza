import { create } from "zustand";

/**
 * State interface for the login modal store.
 */
interface LoginModalState {
  /** Whether the login modal is currently open */
  isOpen: boolean;
  /** Optional context string for tracking where the modal was opened from */
  context?: string;
  /** Optional custom title for the modal */
  title?: string;
  /** Optional custom message to display in the modal */
  message?: string;
  /** Function to show the login modal with optional customization */
  showLoginModal: (options?: {
    context?: string;
    title?: string;
    message?: string;
  }) => void;
  /** Function to close the login modal */
  closeLoginModal: () => void;
}

/**
 * Zustand store hook for managing the login modal state.
 *
 * Provides a global state management solution for showing and hiding the login
 * modal throughout the application. Supports custom titles and messages for
 * context-specific login prompts.
 *
 * @returns The login modal state and control functions.
 *
 * @example
 * ```tsx
 * const { isOpen, showLoginModal, closeLoginModal } = useLoginModal();
 *
 * const handleAction = () => {
 *   showLoginModal({
 *     context: 'trade',
 *     title: 'Sign in to trade',
 *     message: 'You need to be signed in to place trades'
 *   });
 * };
 * ```
 */
export const useLoginModal = create<LoginModalState>((set) => ({
  isOpen: false,
  context: undefined,
  title: undefined,
  message: undefined,
  showLoginModal: (options) =>
    set({
      isOpen: true,
      context: options?.context,
      title: options?.title,
      message: options?.message,
    }),
  closeLoginModal: () =>
    set({
      isOpen: false,
      context: undefined,
      title: undefined,
      message: undefined,
    }),
}));
