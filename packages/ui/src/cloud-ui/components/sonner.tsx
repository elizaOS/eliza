"use client";

/**
 * Sonner toaster configured for the cloud theme (colors follow the theme provider).
 */
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "./theme/theme-provider.hooks";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  if (typeof document === "undefined") return null;
  return createPortal(
    <Sonner
      position="top-right"
      offset="calc(env(safe-area-inset-top, 0px) + 1rem)"
      mobileOffset="calc(env(safe-area-inset-top, 0px) + 1rem)"
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />,
    document.body,
  );
};

export { Toaster };
