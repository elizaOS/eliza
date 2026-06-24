import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        primary: {
          DEFAULT: "#ff4081",
          dark: "#f50057",
          light: "#ff79b0",
        },
        // Accent is a no-blue purple (was indigo #3f51b5) so the pink→accent
        // brand gradient carries zero blue, per the #9300 brand-rule review.
        accent: {
          DEFAULT: "#9c27b0",
          dark: "#7b1fa2",
          light: "#ce93d8",
        },
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "bounce-slow": "bounce 2s infinite",
        "spin-slow": "spin 3s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
