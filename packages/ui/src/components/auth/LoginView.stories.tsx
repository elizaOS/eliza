import type { Meta, StoryObj } from "@storybook/react";
import { TranslationCtx } from "../../state/TranslationContext.hooks";
import { LoginView } from "./LoginView";

// Minimal inline translation context — avoids the real TranslationProvider's
// API/fetch side effects. Each `t(key, { defaultValue })` returns the default.
const translationValue = {
  t: (_key: string, values?: Record<string, unknown>) =>
    typeof values?.defaultValue === "string" ? values.defaultValue : _key,
  uiLanguage: "en" as const,
  setUiLanguage: () => {},
};

const meta = {
  title: "Auth/LoginView",
  component: LoginView,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <TranslationCtx.Provider value={translationValue}>
        <Story />
      </TranslationCtx.Provider>
    ),
  ],
  argTypes: {
    reason: {
      control: "select",
      options: [
        undefined,
        "remote_auth_required",
        "remote_password_not_configured",
      ],
    },
    onLoginSuccess: { action: "loginSuccess" },
  },
  args: {
    onLoginSuccess: () => {},
  },
} satisfies Meta<typeof LoginView>;

export default meta;
type Story = StoryObj<typeof meta>;

const okLogin = async () =>
  ({ ok: true, user: { id: "u_1", displayName: "demo" } }) as never;

const failLogin = async () =>
  ({ ok: false, message: "Incorrect display name or password." }) as never;

const slowLogin = () =>
  new Promise<never>((resolve) => {
    setTimeout(
      () =>
        resolve({
          ok: true,
          user: { id: "u_1", displayName: "demo" },
        } as never),
      60_000,
    );
  });

export const Default: Story = {
  args: {
    loginFn: okLogin,
  },
};

export const RemoteAuthRequired: Story = {
  args: {
    reason: "remote_auth_required",
    loginFn: okLogin,
  },
};

export const RemotePasswordNotConfigured: Story = {
  args: {
    reason: "remote_password_not_configured",
  },
};

export const InvalidCredentials: Story = {
  args: {
    loginFn: failLogin,
  },
};

export const SlowNetwork: Story = {
  args: {
    loginFn: slowLogin,
  },
};
