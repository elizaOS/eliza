import type { Decorator } from "@storybook/react";
import {
  type MockAppOptions,
  MockAppProvider,
  MockTranslationProvider,
} from "./mock-providers";

export const withMockApp: Decorator = (Story) => (
  <MockAppProvider>
    <Story />
  </MockAppProvider>
);

export function mockApp(overrides?: MockAppOptions): Decorator {
  return (Story) => (
    <MockAppProvider value={overrides}>
      <Story />
    </MockAppProvider>
  );
}

/**
 * Decorator that provides only the i18n context (`useTranslation`). Lighter than
 * {@link withMockApp} for components that need a translator but not app state.
 */
export const withMockTranslation: Decorator = (Story) => (
  <MockTranslationProvider>
    <Story />
  </MockTranslationProvider>
);
