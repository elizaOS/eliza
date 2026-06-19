import type { Meta, StoryObj } from "@storybook/react";
import type { ConversationMessage } from "../../api/client-types-chat";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { MessageContent } from "./MessageContent";

// MessageContent calls useApp() and useChatComposer() unconditionally and
// renders many sub-widgets that hit the API client for some segment kinds.
// To keep stories pure and rendering, every story wraps in a MockAppProvider
// (which proxies any unimplemented method to a no-op) and uses plain text or
// early-return branches that bail before touching the network.
const baseMessage: ConversationMessage = {
  id: "msg_demo",
  role: "assistant",
  text: "Hey! I checked your calendar — you have a free hour after 3pm today.",
  timestamp: Date.now(),
};

function makeMessage(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return { ...baseMessage, ...overrides };
}

const meta = {
  title: "Chat/MessageContent",
  component: MessageContent,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
  argTypes: {
    analysisMode: { control: "boolean" },
  },
  args: {
    message: baseMessage,
    analysisMode: false,
  },
  decorators: [mockApp()],
} satisfies Meta<typeof MessageContent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Plain assistant reply — the fast path: single text segment. */
export const Default: Story = {};

/** Multiline text wraps preserved via whitespace-pre-wrap. */
export const Multiline: Story = {
  args: {
    message: makeMessage({
      text: "Here is the plan:\n\n1. Confirm the venue\n2. Send invites\n3. Lock the menu by Friday",
    }),
  },
};

/** `failureKind: "no_provider"` renders the structured gate with Settings CTA. */
export const NoProviderGate: Story = {
  args: {
    message: makeMessage({
      text: "No provider is wired up — connect one to start chatting.",
      failureKind: "no_provider",
    }),
  },
};

/** Local-inference `downloading` status shows the warn banner + progress CTA. */
export const LocalModelDownloading: Story = {
  args: {
    message: makeMessage({
      text: "Downloading the local model so we can keep this conversation on-device.",
      localInference: {
        status: "downloading",
        modelId: "llama-3.1-8b-instruct-q4",
        progress: {
          percent: 42,
          receivedBytes: 2_100_000_000,
          totalBytes: 5_000_000_000,
        },
      },
    }),
  },
};

/** Pending secret request renders the SensitiveRequestBlock with a form. */
export const SecretRequest: Story = {
  args: {
    message: makeMessage({
      text: "",
      secretRequest: {
        key: "OPENAI_API_KEY",
        reason: "Needed to call the OpenAI provider on your behalf.",
        status: "pending",
        delivery: {
          mode: "inline_owner_app",
          canCollectValueInCurrentChannel: true,
        },
        form: {
          type: "sensitive_request_form",
          kind: "secret",
          mode: "inline_owner_app",
          submitLabel: "Save key",
          fields: [
            {
              name: "OPENAI_API_KEY",
              label: "API key",
              input: "secret",
              required: true,
            },
          ],
        },
      },
    }),
  },
};

/** Analysis mode surfaces XML reasoning blocks + action-name footer. */
export const AnalysisMode: Story = {
  args: {
    analysisMode: true,
    message: makeMessage({
      text: "<thought>Checking the calendar.</thought>\n<response>You're free after 3pm.</response>",
      actionName: "CALENDAR_LOOKUP",
      actionCallbackHistory: [
        "[CALENDAR_LOOKUP] querying primary calendar",
        "[CALENDAR_LOOKUP] 1 free window found",
      ],
    }),
  },
};
