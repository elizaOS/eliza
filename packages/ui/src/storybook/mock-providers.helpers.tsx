/**
 * Helpers for the Storybook mock providers (options + composed decorator) used
 * across stories.
 */
import type { Decorator } from "@storybook/react";
import { type MockAppOptions, MockAppProvider } from "./mock-providers";

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
