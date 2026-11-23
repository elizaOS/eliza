import "@repo/design-system/theme.css";

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
