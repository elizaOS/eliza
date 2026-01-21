"use client";

import { logger } from "@polyagent/shared";
import { usePrivy } from "@privy-io/react-auth";
import { useEffect, useRef } from "react";

/**
 * Login modal component that triggers Privy's native login modal.
 *
 * Acts as a wrapper that triggers Privy's built-in authentication modal when
 * opened. Automatically closes when user successfully authenticates. Supports
 * custom title and message for context-specific login prompts.
 *
 * Note: This component doesn't render any UI itself - it delegates to Privy's
 * native modal system.
 *
 * @param props - LoginModal component props
 * @returns null (delegates to Privy's native modal)
 *
 * @example
 * ```tsx
 * <LoginModal
 *   isOpen={showLogin}
 *   onClose={() => setShowLogin(false)}
 *   title="Sign in to trade"
 *   message="You need to be signed in to place trades"
 * />
 * ```
 */
interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
}

export function LoginModal({
  isOpen,
  onClose,
  title,
  message,
}: LoginModalProps) {
  const { login, authenticated, ready } = usePrivy();
  const attemptedLoginRef = useRef(false);

  // Close modal when user logs in
  useEffect(() => {
    if (authenticated && isOpen) {
      onClose();
    }
  }, [authenticated, isOpen, onClose]);

  // Trigger Privy's built-in login modal when this component opens
  useEffect(() => {
    if (!isOpen || !ready || authenticated) {
      attemptedLoginRef.current = false;
      return;
    }

    if (!attemptedLoginRef.current) {
      attemptedLoginRef.current = true;
      login();
    }
  }, [isOpen, ready, authenticated, login]);

  // Log title/message if provided for debugging
  useEffect(() => {
    if (title) {
      logger.debug("LoginModal title:", title, "LoginModal");
    }
    if (message) {
      logger.debug("LoginModal message:", message, "LoginModal");
    }
  }, [title, message]);

  // This component just triggers Privy's native modal, no custom UI needed
  return null;
}
