import path from "node:path";
import { fileURLToPath } from "node:url";
import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.mocha,
        ...globals.node,
        artifacts: "readonly",
        contract: "readonly",
        web3: "readonly",
        extendEnvironment: "readonly",
        expect: "readonly",
      },
    },
  },
  includeIgnoreFile(path.resolve(__dirname, ".gitignore")),
];
