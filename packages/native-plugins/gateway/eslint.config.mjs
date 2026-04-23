import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tsParser = require("@typescript-eslint/parser");

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "android/**",
      "ios/**",
      "coverage/**",
      "electrobun/**",
      "electrobun/src/**/*.bak",
    ],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
  },
];
