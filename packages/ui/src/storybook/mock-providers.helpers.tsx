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
