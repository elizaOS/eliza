/**
 * Storybook states for the MessageContent chat component used by message
 * rendering, attachments, and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { ConversationMessage } from "../../api/client-types-chat";
import { assert } from "../../storybook/home-widget-decorator";
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

/** Submitted inline forms render as a receipt, never raw transport syntax. */
export const SubmittedInlineForm: Story = {
  args: {
    message: makeMessage({
      role: "user",
      text: '[form:submit reminder] {"title":"Quarterly report","time":"5pm"}',
    }),
  },
  play: async ({ canvasElement }) => {
    const text = canvasElement.textContent ?? "";
    assert(
      /submitted reminder/i.test(text),
      "submitted form receipt is visible",
    );
    assert(!text.includes("[form:submit"), "transport marker is hidden");
    assert(!text.includes("Quarterly report"), "field values are hidden");
    assert(!text.includes("5pm"), "time value is hidden");
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

/**
 * `accountConnect` renders the AccountConnectBlock: a per-provider row (name +
 * current count + "Add account") that opens the existing AddAccountDialog
 * OAuth/API-key flow inline. Live account counts come from the api client
 * (`listAccounts`), so outside a running backend the rows show "0 connected".
 */
export const AccountConnect: Story = {
  args: {
    message: makeMessage({
      text: "Sure — pick a provider below to sign into another account.",
      accountConnect: {
        providers: ["anthropic-subscription", "openai-codex"],
        reason: "You asked to connect another provider account.",
      },
    }),
  },
};

/**
 * `failureKind: "rate_limited"` (and `provider_issue`) render the graceful
 * message with a one-tap Retry that resends the preceding user turn.
 */
export const RateLimitedRetry: Story = {
  args: {
    message: makeMessage({
      text: "The agent is busy right now — wait a few seconds and try again.",
      failureKind: "rate_limited",
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

/**
 * #8910 — a sensitive request can collect an image (e.g. photograph a 2FA seed
 * or QR). Renders a file input with camera capture on mobile; the upload is
 * delivered as a data URL through the existing submit path.
 */
export const SecretRequestImageField: Story = {
  args: {
    message: makeMessage({
      text: "",
      secretRequest: {
        key: "TOTP_SEED_PHOTO",
        reason: "Photograph the 2FA seed shown on the other device.",
        status: "pending",
        delivery: {
          mode: "inline_owner_app",
          instruction: "Upload a clear photo of the seed.",
          canCollectValueInCurrentChannel: true,
        },
        form: {
          type: "sensitive_request_form",
          kind: "secret",
          mode: "inline_owner_app",
          submitLabel: "Upload",
          fields: [
            {
              name: "seed_photo",
              label: "Seed photo",
              input: "image",
              required: true,
              mimeTypes: ["image/png", "image/jpeg"],
              maxBytes: 5_000_000,
            },
          ],
        },
      },
    }),
  },
};

/**
 * #8910 — a sensitive request can also collect a non-image file (e.g. a
 * keystore/backup). Renders a plain file input scoped by `mimeTypes`, without
 * the camera-capture hint reserved for image fields.
 */
export const SecretRequestFileField: Story = {
  args: {
    message: makeMessage({
      text: "",
      secretRequest: {
        key: "WALLET_KEYSTORE",
        reason: "Attach the encrypted keystore file to import.",
        status: "pending",
        delivery: {
          mode: "inline_owner_app",
          instruction: "Attach the .json keystore file.",
          canCollectValueInCurrentChannel: true,
        },
        form: {
          type: "sensitive_request_form",
          kind: "secret",
          mode: "inline_owner_app",
          submitLabel: "Upload",
          fields: [
            {
              name: "keystore",
              label: "Keystore file",
              input: "file",
              required: true,
              mimeTypes: ["application/json"],
              maxBytes: 1_000_000,
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

/** Thinking details: the agent's reasoning rendered as a collapsed-by-default
 * ThinkingBlock, separate from the visible reply. */
export const ThinkingDetails: Story = {
  args: {
    message: makeMessage({
      reasoning:
        "Cross-referencing the calendar with the requested window, then checking flight options under the loyalty program before committing to a recommendation.",
      text: "You're free after 3pm — want me to hold the 4:10pm flight?",
    }),
  },
};

/** Suggestion chips: a `[FOLLOWUPS]` block becomes a dismissible chip row. */
export const Followups: Story = {
  args: {
    message: makeMessage({
      text: "Here's your itinerary.\n[FOLLOWUPS]\nrerun=Run again\nexport=Export to calendar\n[/FOLLOWUPS]",
    }),
  },
};

/** Choice picker: a `[CHOICE:...]` block becomes an inline button row. */
export const ChoicePicker: Story = {
  args: {
    message: makeMessage({
      text: "Approve this booking?\n[CHOICE:approval id=c1]\nyes=Approve\nno=Reject\n[/CHOICE]",
    }),
  },
};

/**
 * Fenced code block (#9148): assistant ```code``` renders via the CodeBlock
 * primitive with a per-block copy button instead of undifferentiated prose;
 * inline `code` spans render inline and keep their place in the sentence.
 */
export const CodeBlocks: Story = {
  args: {
    message: makeMessage({
      text: "Run `npm install` first, then add this to `vite.config.ts`:\n```ts\nexport default defineConfig({\n  plugins: [react()],\n});\n```\nThat wires up the dev server.",
    }),
  },
};

/** Inline form: a `[FORM]` block becomes a structured multi-field form. */
export const InlineForm: Story = {
  args: {
    message: makeMessage({
      text: `Fill this out and I'll book it:\n[FORM]\n${JSON.stringify({
        title: "Trip details",
        submitLabel: "Book",
        fields: [
          { name: "destination", type: "text", label: "Destination" },
          { name: "date", type: "text", label: "Departure date" },
        ],
      })}\n[/FORM]`,
    }),
  },
};
