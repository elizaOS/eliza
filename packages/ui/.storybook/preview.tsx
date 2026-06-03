import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";
import { TooltipProvider } from "@elizaos/ui/components/ui/tooltip";

// The bundled UI stylesheets (tokens, base, brand) — the renderer entry, so the
// catalog looks exactly like the app.
import "@elizaos/ui/styles";

const preview: Preview = {
  parameters: {
    controls: {
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    layout: "centered",
    backgrounds: { disable: true }, // theme classes own the background
  },
  decorators: [
    (Story) => (
      <TooltipProvider delayDuration={200} skipDelayDuration={100}>
        <Story />
      </TooltipProvider>
    ),
    // Light/dark by toggling the `dark` class on the preview root — matches how
    // the app themes (the design tokens key off it).
    withThemeByClassName({
      themes: { light: "", dark: "dark" },
      defaultTheme: "dark",
    }),
  ],
};

export default preview;
