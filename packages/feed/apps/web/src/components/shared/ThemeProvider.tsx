"use client";

/**
 * Theme provider component wrapping next-themes ThemeProvider.
 *
 * Provides theme management (light/dark/system) for the application.
 * Uses next-themes under the hood with sensible defaults for class-based
 * theme switching.
 *
 * @param props - ThemeProvider component props (from next-themes)
 * @returns Theme provider element
 *
 * @example
 * ```tsx
 * <ThemeProvider>
 *   <App />
 * </ThemeProvider>
 * ```
 */
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
} from "next-themes";

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
