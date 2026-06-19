import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";
import "@elizaos/ui";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    layout: "centered",
    viewport: {
      options: {
        companionPortrait: {
          name: "Companion Portrait",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        companionDesktop: {
          name: "Companion Desktop",
          styles: { width: "1280px", height: "800px" },
          type: "desktop",
        },
        companionPip: {
          name: "Companion PIP",
          styles: { width: "320px", height: "480px" },
          type: "mobile",
        },
      },
    },
  },
  decorators: [
    withThemeByClassName({
      themes: {
        light: "",
        dark: "dark",
      },
      defaultTheme: "light",
    }),
  ],
};

export default preview;
