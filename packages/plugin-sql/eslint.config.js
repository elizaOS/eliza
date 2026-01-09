import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ESLint config for plugin-sql
 * Standalone config without @elizaos/config dependency
 */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    rules: {
      // plugin-sql specific overrides
      "@typescript-eslint/no-unused-vars": "off",
      "no-control-regex": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
