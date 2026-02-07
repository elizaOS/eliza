import nextConfig from "eslint-config-next";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const eslintConfig = [
  ...nextConfig,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "docs/**",
      "tests/playwright/test-reports/**",
      "tests/playwright/test-results/**",
    ],
  },
  // React Hooks Rules - Critical for preventing unnecessary re-renders and API spam
  {
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      // Enforce Rules of Hooks - catches common mistakes
      "react-hooks/rules-of-hooks": "error",

      // Exhaustive deps - prevents stale closures and missing dependencies
      // This is CRITICAL for preventing infinite loops and unnecessary API calls
      "react-hooks/exhaustive-deps": [
        "warn",
        {
          // Add custom hooks that have dependency arrays
          additionalHooks:
            "(useDeepMemo|useDeepCallback|useDebounce|useDedupedFetch)",
        },
      ],

      // Prevent passing unstable references (inline objects/arrays/functions) to child components
      // This causes unnecessary re-renders of memoized children
      "react/jsx-no-constructed-context-values": "error",

      // Warn about components that might benefit from memo()
      // Note: Not always needed, but good to be aware of
      "react/jsx-no-useless-fragment": "warn",
    },
  },
];

export default eslintConfig;
