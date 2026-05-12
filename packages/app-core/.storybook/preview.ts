import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";
import "../../app-core/src/styles/styles.css";

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
        mobilePortrait: {
          name: "Mobile Portrait",
          styles: { width: "390px", height: "844px" },
          type: "mobile",
        },
        mobileLandscape: {
          name: "Mobile Landscape",
          styles: { width: "844px", height: "390px" },
          type: "mobile",
        },
        ipadPortrait: {
          name: "iPad Portrait",
          styles: { width: "820px", height: "1180px" },
          type: "tablet",
        },
        desktopWide: {
          name: "Desktop Wide",
          styles: { width: "1440px", height: "960px" },
          type: "desktop",
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
