module.exports = {
  input: [
    "src/**/*.{js,jsx}",
    // Use ! to filter out files or directories
    "!src/**/*.test.{js,jsx}",
    "!src/i18n/**",
    "!**/node_modules/**",
  ],
  output: "./",
  options: {
    debug: true,
    func: {
      list: ["i18next.t", "i18n.t", "t"],
      extensions: [".js", ".jsx"],
    },
    trans: {
      component: "Trans",
      i18nKey: "i18nKey",
      defaultsKey: "defaults",
      extensions: [".js", ".jsx"],
      fallbackKey: function (ns, value) {
        return value;
      },
      acorn: {
        ecmaVersion: 11, // defaults to 10
        sourceType: "module", // defaults to 'module'
        // Check out https://github.com/acornjs/acorn/tree/master/acorn#interface for additional options
      },
    },
    lngs: ["en", "fr"],
    ns: ["locale", "resource"],
    defaultLng: "en",
    defaultNs: "resource",
    defaultValue: "__NOT_TRANSLATED__",
    resource: {
      loadPath: "src/i18n/{{lng}}.json",
      savePath: "src/i18n/{{lng}}.json",
      jsonIndent: 2,
      lineEnding: "\n",
    },
    nsSeparator: false, // namespace separator
    keySeparator: false, // key separator
    interpolation: {
      prefix: "{{",
      suffix: "}}",
    },
  },
};
