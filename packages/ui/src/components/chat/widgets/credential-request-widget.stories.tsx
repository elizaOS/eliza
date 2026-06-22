import type { Meta, StoryObj } from "@storybook/react";
import { CredentialRequestWidget } from "./credential-request-widget";

const meta = {
  title: "Chat/Widgets/CredentialRequestWidget",
  component: CredentialRequestWidget,
  tags: ["autodocs"],
  argTypes: {
    onAuthorize: { action: "authorize" },
    onSubmitSecret: { action: "submitSecret" },
    onSubmitImage: { action: "submitImage" },
  },
} satisfies Meta<typeof CredentialRequestWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OauthLink: Story = {
  args: {
    variant: {
      kind: "oauth-link",
      provider: "GitHub",
      authorizeUrl: "https://github.com/login/oauth/authorize",
      status: "idle",
    },
    onAuthorize: () => {},
  },
};

export const PasteSecret: Story = {
  args: {
    variant: {
      kind: "paste-secret",
      label: "OpenAI API key",
      placeholder: "sk-...",
      helpText: "Stored encrypted in your vault — never shown in chat.",
    },
    onSubmitSecret: () => {},
  },
};

export const ImageUpload: Story = {
  args: {
    variant: {
      kind: "image-upload",
      label: "2FA QR code",
      accept: "image/*",
    },
    onSubmitImage: () => {},
  },
};
