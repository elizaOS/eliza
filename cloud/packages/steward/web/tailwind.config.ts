import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', '"Fira Code"', "monospace"],
      },
      colors: {
        bg: {
          DEFAULT: "#0b0a09",
          elevated: "#141210",
          surface: "#1c1a17",
          hover: "#242119",
        },
        text: {
          DEFAULT: "#e8e5e0",
          secondary: "#9c9788",
          tertiary: "#6b6560",
        },
        border: {
          DEFAULT: "#2a2722",
          subtle: "#1f1d1a",
        },
        accent: {
          DEFAULT: "oklch(0.75 0.15 55)",
          hover: "oklch(0.8 0.17 55)",
          muted: "oklch(0.45 0.08 55)",
          bg: "oklch(0.2 0.04 55)",
        },
      },
      spacing: {
        18: "4.5rem",
        22: "5.5rem",
        30: "7.5rem",
        34: "8.5rem",
      },
      fontSize: {
        hero: ["clamp(3.5rem, 8vw + 1rem, 8rem)", { lineHeight: "0.95", letterSpacing: "-0.03em" }],
        "hero-landing": [
          "clamp(3rem, 6vw + 0.5rem, 6rem)",
          { lineHeight: "0.92", letterSpacing: "-0.03em" },
        ],
        "hero-sm": [
          "clamp(2.5rem, 5vw + 1rem, 5rem)",
          { lineHeight: "0.95", letterSpacing: "-0.02em" },
        ],
      },
      animation: {
        "fade-in": "fadeIn 0.6s var(--ease-out-quart) forwards",
        "slide-up": "slideUp 0.6s var(--ease-out-expo) forwards",
        "slide-in-left": "slideInLeft 0.6s var(--ease-out-expo) forwards",
      },
      keyframes: {
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        slideUp: {
          from: { opacity: "0", transform: "translateY(20px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideInLeft: {
          from: { opacity: "0", transform: "translateX(-20px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
