/** Presents developer catalog and provider uncertainty through the real SDK with deterministic HTTP fixtures. */
import type { Meta, StoryObj } from "@storybook/react";
import { catalogFixture } from "./app-catalog-fixture";
import { AppCatalogSettings } from "./app-catalog-settings";

const fixture = catalogFixture();
const meta = {
  title: "Cloud/Apps/Subscription catalog",
  component: AppCatalogSettings,
  args: { client: fixture.client, appId: "app-a", userId: "developer-a" },
} satisfies Meta<typeof AppCatalogSettings>;
export default meta;
export const ChooseEnvironment: StoryObj<typeof meta> = {};
