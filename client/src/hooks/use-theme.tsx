import { useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

function useTheme() {
    const [theme, setTheme] = useState<Theme>(
        () => (localStorage.getItem("theme") as Theme) || "system"
    );

    useEffect(() => {
        const media = window.matchMedia("(prefers-color-scheme: dark)");

        function applyTheme() {
            const root = window.document.documentElement;
            const systemTheme = media.matches ? "dark" : "light";
            const activeTheme = theme === "system" ? systemTheme : theme;

            root.classList.remove("light", "dark");
            root.classList.add(activeTheme);
            localStorage.setItem("theme", theme);
        }

        applyTheme();
        media.addEventListener("change", applyTheme);
        return () => media.removeEventListener("change", applyTheme);
    }, [theme]);

    return { theme, setTheme } as const;
}

export { useTheme };
export type { Theme };
