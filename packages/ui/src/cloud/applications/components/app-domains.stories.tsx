/** Exercises the real domain-removal confirmation with an isolated read-only HTTP fixture. */
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";
import { AppDomains } from "./app-domains";

const meta = {
  title: "Cloud/Applications/AppDomains",
  component: AppDomains,
  args: { appId: "contrast-review-app" },
  decorators: [
    (Story) => (
      <CloudI18nProvider>
        <Story />
      </CloudI18nProvider>
    ),
  ],
  beforeEach: () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.href,
      );
      if (!url.pathname.startsWith("/api/v1/apps/contrast-review-app/"))
        return original(input, init);
      const method =
        init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET" || !url.pathname.endsWith("/domains")) {
        return Response.json(
          { error: "This confirmation fixture is read-only" },
          { status: 403 },
        );
      }
      // The managed-domain rows GET /api/v1/apps/:id/domains returns.
      return Response.json({
        success: true,
        domains: [
          {
            id: "contrast-review-domain",
            domain: "review.example.test",
            registrar: "external",
            status: "active",
            verified: true,
            sslStatus: "active",
            expiresAt: null,
            cloudflareZoneId: null,
            verificationToken: null,
          },
        ],
      });
    };
    return () => {
      globalThis.fetch = original;
    };
  },
} satisfies Meta<typeof AppDomains>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RemoveDomainConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Remove domain", exact: true }),
    );
    const dialog = await within(canvasElement.ownerDocument.body).findByRole(
      "alertdialog",
    );
    await expect(
      within(dialog).getByText("review.example.test", { exact: true }),
    ).toBeVisible();
    await expect(
      within(dialog).getByRole("button", {
        name: "Remove Domain",
        exact: true,
      }),
    ).toBeVisible();
  },
};
