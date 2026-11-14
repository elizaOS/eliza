import "@repo/design-system/theme.css";

/** The toolbar's theme switch sets the class the tokens' dark values hang on. */
export default {
  globalTypes: { theme: { toolbar: { icon: "contrast", items: ["light", "dark"], dynamicTitle: true } } },
  initialGlobals: { theme: "light" },
  decorators: [
    (Story: () => unknown, context: { globals: { theme: string } }) => {
      document.documentElement.className = context.globals.theme;
      return Story();
    },
  ],
};
