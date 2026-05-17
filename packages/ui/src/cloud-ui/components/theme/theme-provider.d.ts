import * as React from "react";
type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";
interface ThemeProviderProps {
    children: React.ReactNode;
    attribute?: "class" | "data-theme";
    defaultTheme?: Theme;
    enableSystem?: boolean;
    disableTransitionOnChange?: boolean;
    storageKey?: string;
}
interface ThemeContextValue {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    resolvedTheme: ResolvedTheme;
    systemTheme: ResolvedTheme;
}
export declare function ThemeProvider({ children, attribute, defaultTheme, enableSystem, disableTransitionOnChange, storageKey, }: ThemeProviderProps): import("react/jsx-runtime").JSX.Element;
export declare function useTheme(): ThemeContextValue;
export {};
//# sourceMappingURL=theme-provider.d.ts.map