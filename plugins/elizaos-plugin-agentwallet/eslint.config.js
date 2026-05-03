import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [{
  files: ["src/**/*.ts"],
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parser: tsParser,
    globals: { ...globals.node }
  },
  plugins: { "@typescript-eslint": tsPlugin },
  rules: {
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    "no-eval": "error",
    "no-implied-eval": "error",
    "prefer-const": "warn",
    "eqeqeq": "warn"
  }
}, {
  files: ["src/**/*.js"],
  languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.node } },
  rules: {
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    "no-eval": "error",
    "no-implied-eval": "error",
    "prefer-const": "warn",
    "eqeqeq": "warn"
  }
}];
