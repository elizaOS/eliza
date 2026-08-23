/**
 * Storybook stories for BootstrapStep — default, invalid-token, rate-limited,
 * server-not-ready, and verifying states. Error/verifying states are reached
 * through play functions (paste a token and submit) because the component only
 * surfaces them after an exchange attempt; without the interaction every
 * story renders the idle form. The decorator mirrors the runtime
 * BootstrapGateShell (dark `bg-bg text-txt` shell), not a light panel, so the
 * first-run text tokens render against their real background.
 */

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
      <div className="dark relative flex min-h-96 w-full flex-col items-center justify-center bg-bg p-8 text-txt">
        <div className="w-full max-w-xl">{children}</div>
      </div>
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

/** Minimal assertion helper (no @storybook/test in repo — see home-widget-card). */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`BootstrapStep story: ${message}`);
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
  // React overrides the value setter; go through the prototype so the
  // change event reaches React's onChange.
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitForText(
  root: HTMLElement,
  text: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (root.textContent?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(false, `expected text to appear: "${text.slice(0, 60)}"`);
}

/** Paste a token and submit so the story lands in its post-exchange state. */
async function submitToken(canvasElement: HTMLElement, expectedText: string) {
  const input = canvasElement.querySelector<HTMLInputElement>(
    'input[type="password"]',
  );
  assert(input, "token input renders");
  setNativeInputValue(input, "bs_test_token_1234");
  const form = canvasElement.querySelector("form");
  assert(form, "form renders");
  form.requestSubmit();
  await waitForText(canvasElement, expectedText);
}

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
  play: async ({ canvasElement }) => {
    await submitToken(
      canvasElement,
      "Token invalid, expired, or already used. Bootstrap tokens are single-use — rotate from your Eliza Cloud dashboard to get a new one.",
    );
  },
};

export const RateLimited: Story = {
  args: {
    exchangeFn: rateLimitedExchange,
  },
  play: async ({ canvasElement }) => {
    await submitToken(
      canvasElement,
      "Too many attempts — wait a minute and try again.",
    );
  },
};

export const ServerNotReady: Story = {
  args: {
    exchangeFn: serverNotReadyExchange,
  },
  play: async ({ canvasElement }) => {
    await submitToken(
      canvasElement,
      "The server is not ready. Reload the page and try again.",
    );
  },
};

export const Verifying: Story = {
  args: {
    exchangeFn: pendingExchange,
  },
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    assert(input, "token input renders");
    setNativeInputValue(input, "bs_test_token_1234");
    const form = canvasElement.querySelector("form");
    assert(form, "form renders");
    form.requestSubmit();
    await waitForText(canvasElement, "Verifying…");
  },
};
