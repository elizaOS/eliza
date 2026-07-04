/** Storybook stories for BootstrapStep — default, invalid-token, rate-limited, server-not-ready, and verifying states. */

import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import type { BootstrapExchangeResult } from "../../api/client-agent";
import {
  type TranslationContextValue,
  TranslationCtx,
} from "../../state/TranslationContext.hooks";
import { BootstrapStep } from "./BootstrapStep";

const translationValue: TranslationContextValue = {
  t: (_key, values) =>
    typeof values?.defaultValue === "string" ? values.defaultValue : _key,
  uiLanguage: "en",
  setUiLanguage: () => {},
};

function TranslationDecorator({ children }: { children: ReactNode }) {
  return (
    <TranslationCtx.Provider value={translationValue}>
      <div className="max-w-xl mx-auto p-8">{children}</div>
    </TranslationCtx.Provider>
  );
}

const successExchange = async (
  _token: string,
): Promise<BootstrapExchangeResult> => ({
  ok: true,
  sessionId: "sess_placeholder_abc123",
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  identityId: "identity_placeholder_xyz",
});

const invalidTokenExchange = async (
  _token: string,
): Promise<BootstrapExchangeResult> => ({
  ok: false,
  status: 401,
  error: "invalid_token",
});

const rateLimitedExchange = async (
  _token: string,
): Promise<BootstrapExchangeResult> => ({
  ok: false,
  status: 429,
  error: "rate_limited",
});

const serverNotReadyExchange = async (
  _token: string,
): Promise<BootstrapExchangeResult> => ({
  ok: false,
  status: 503,
  error: "server_not_ready",
});

const pendingExchange = (_token: string): Promise<BootstrapExchangeResult> =>
  // Never resolves — keeps the form stuck in the "Verifying…" state.
  new Promise(() => {});

const meta = {
  title: "Setup/BootstrapStep",
  component: BootstrapStep,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <TranslationDecorator>
        <Story />
      </TranslationDecorator>
    ),
  ],
  argTypes: {
    onAdvance: { action: "advance" },
    exchangeFn: { control: false },
  },
  args: {
    onAdvance: () => {},
    exchangeFn: successExchange,
  },
} satisfies Meta<typeof BootstrapStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InvalidToken: Story = {
  args: {
    exchangeFn: invalidTokenExchange,
  },
};

export const RateLimited: Story = {
  args: {
    exchangeFn: rateLimitedExchange,
  },
};

export const ServerNotReady: Story = {
  args: {
    exchangeFn: serverNotReadyExchange,
  },
};

export const Verifying: Story = {
  args: {
    exchangeFn: pendingExchange,
  },
};
