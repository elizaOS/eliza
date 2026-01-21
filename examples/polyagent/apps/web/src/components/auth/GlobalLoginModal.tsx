"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useLoginModal } from "@/hooks/useLoginModal";
import { LoginModal } from "./LoginModal";

/**
 * Global login modal content component.
 *
 * Connects to the global login modal state and displays LoginModal when needed.
 * Automatically hides on production home page unless dev mode is enabled.
 * Uses Zustand store for global state management.
 *
 * @returns Global login modal element or null if hidden/not open
 */
function GlobalLoginModalContent() {
  const { isOpen, closeLoginModal, title, message } = useLoginModal();
  const searchParams = useSearchParams();

  // Check if dev mode is enabled via URL parameter
  const isDevMode = searchParams.get("dev") === "true";

  // Hide on production (polyagent.app) on home page unless ?dev=true
  const isProduction =
    typeof window !== "undefined" &&
    window.location.hostname === "polyagent.app";
  const isHomePage =
    typeof window !== "undefined" && window.location.pathname === "/";
  const shouldHide = isProduction && isHomePage && !isDevMode;

  // If should be hidden, don't render anything
  if (shouldHide) {
    return null;
  }

  return (
    <LoginModal
      isOpen={isOpen}
      onClose={closeLoginModal}
      title={title}
      message={message}
    />
  );
}

/**
 * Global login modal component wrapper with Suspense boundary.
 *
 * Wraps GlobalLoginModalContent in a Suspense boundary to handle async navigation
 * hooks gracefully. Provides a global login modal accessible throughout the app.
 *
 * @returns Global login modal element wrapped in Suspense
 */
export function GlobalLoginModal() {
  return (
    <Suspense fallback={null}>
      <GlobalLoginModalContent />
    </Suspense>
  );
}
