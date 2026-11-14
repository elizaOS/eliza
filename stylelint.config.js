export default {
  extends: ["stylelint-config-standard"],
  // Other checkouts of this repository, then what is generated or outside the workspace; what is left is hand-written, such as apps/app/src/main.css.
  ignoreFiles: [".claude/**", "**/node_modules/**", "**/gen/**", "**/dist/**", "**/.cache/**", "**/.spec-cache/**", "**/generated/**", "**/storybook-static/**", "vibestack/examples/**", "vibestack/fixtures/**"],
  rules: {
    // A Tailwind v4 entry names what to scan with @source, and Tailwind inlines only an @import written as a string.
    "at-rule-no-unknown": [true, { ignoreAtRules: ["source"] }],
    "import-notation": "string",
    // @source sits directly under the @import whose classes it completes.
    "at-rule-empty-line-before": ["always", { except: ["blockless-after-same-name-blockless", "first-nested"], ignore: ["after-comment"], ignoreAtRules: ["source"] }],
  },
}
