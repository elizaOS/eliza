import eslintGlobalConfig from "../../eslint.config.mjs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import tsParser from "@typescript-eslint/parser";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default [
  ...eslintGlobalConfig,
  {
    files: ["src/**/*.ts"],  // Only target source .ts files
    ignores: [
      "dist/**/*",
      "**/*.d.ts",     // Ignore all declaration files
      "**/*.did.*",    // Ignore all .did files regardless of extension
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./tsconfig.json"],
        tsconfigRootDir: __dirname,
      },
    },
  },
];
