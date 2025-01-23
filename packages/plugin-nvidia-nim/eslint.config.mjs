import eslintGlobalConfig from "../../eslint.config.mjs";

export default [
  ...eslintGlobalConfig,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Disable problematic rules
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
];
