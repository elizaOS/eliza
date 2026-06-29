// @vitest-environment jsdom
//
// Component-tree render-parity contract (#9954).
//
// The chat thread renders through TWO React trees: the overlay
// (ContinuousChatOverlay → ThreadLine → InlineWidgetText) and the full ChatView
// (ChatTranscript → MessageContent). The PARSER layer is already deduped + pinned
// (parser-parity.contract.test.ts, #9304) — both call the same `parseSegments`.
// This contract guards the layer ABOVE the parser: that the two component trees
// emit the SAME interactive-widget / code-block / reasoning / secret-request
// STRUCTURE for a shared message corpus. If a future edit to either tree adds,
// drops, or diverges a structural affordance, this fails.
//
// It is structural, not pixel-level: the two surfaces legitimately differ in
// chrome (bubble glass vs flat row), animation, and the press-and-hold copy
// affordance. What must NOT diverge is which rich blocks render — a code block
// on one surface and leaked ``` text on the other, or a widget on one and a raw
// `[CHOICE]` marker on the other, is exactly the drift this catches.

import { cleanup, render } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConversationMessage,
  ConversationSecretRequest,
} from "../../api/client-types-chat";
import { __setAppValueForTests } from "../../state/app-store";
import { AppContext } from "../../state/useApp";
import type { ShellMessage } from "../shell/shell-state";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getPermission: vi.fn().mockResolvedValue({
      id: "reminders",
      status: "not-determined",
      lastChecked: 0,
      canRequest: true,
      platform: "darwin",
    }),
    getPlugins: vi.fn().mockResolvedValue([]),
    openPermissionSettings: vi.fn(),
    requestPermission: vi.fn(),
    updatePlugin: vi.fn(),
    startLocalInferenceDownload: vi.fn(),
  },
}));
vi.mock("../../api/client", () => ({ client: clientMock }));

import { __renderThreadLineForParity } from "../shell/ContinuousChatOverlay";
// MessageContent (ChatView path) and ThreadLine (overlay path) both render real
// inline widgets; import them after the mocks are in place.
import { MessageContent } from "./MessageContent";
// Side effect: register the built-in inline widgets so both surfaces resolve them.
import "./widgets/inline-builtins";
import { registerTaskWidget } from "./widgets/task-widget";

registerTaskWidget();

function withApp(node: React.ReactElement) {
  const appValue = {
    t: (key: string, vars?: Record<string, unknown>) =>
      String(vars?.defaultValue ?? key),
    loadPlugins: vi.fn(() => Promise.resolve()),
    sendActionMessage: vi.fn(),
    setActionNotice: vi.fn(),
    setTab: vi.fn(),
    handleChatRetry: vi.fn(),
  } as never;
  __setAppValueForTests(appValue);
  return render(
    <AppContext.Provider value={appValue}>{node}</AppContext.Provider>,
  );
}

/**
 * The structural fingerprint of a rendered message: which rich, interactive
 * affordances the tree emitted. Both render paths must produce the SAME set for
 * a given message — that's the parity invariant. Chrome/animation/copy
 * affordances are deliberately excluded (they legitimately differ).
 */
interface StructuralFingerprint {
  hasChoiceWidget: boolean;
  choiceOptionValues: string[];
  hasCodeBlock: boolean;
  codeBlockCount: number;
  hasSecretRequest: boolean;
  hasReasoning: boolean;
  hasNoProviderGate: boolean;
}

function fingerprint(root: HTMLElement): StructuralFingerprint {
  const choiceOptions = Array.from(
    root.querySelectorAll('[data-testid^="choice-"]'),
  )
    .map((el) => el.getAttribute("data-testid") ?? "")
    .filter((id) => id.startsWith("choice-") && !id.startsWith("choice-custom"))
    .sort();
  const codeBlocks = root.querySelectorAll('[data-testid="code-block"]');
  // The reasoning block (ThinkingBlock) has no testid; it is the accent-bordered
  // disclosure whose toggle includes the label "Thinking" (alongside a chevron
  // glyph). Detect it structurally.
  const hasReasoning = Array.from(root.querySelectorAll("button")).some((b) =>
    b.textContent?.includes("Thinking"),
  );
  // The no_provider recovery gate renders the literal "Connect a provider to
  // chat" heading on both surfaces.
  const hasNoProviderGate = root.textContent?.includes(
    "Connect a provider to chat",
  );
  return {
    hasChoiceWidget: choiceOptions.length > 0,
    choiceOptionValues: choiceOptions,
    hasCodeBlock: codeBlocks.length > 0,
    codeBlockCount: codeBlocks.length,
    hasSecretRequest:
      root.querySelector('[data-testid="sensitive-request"]') !== null,
    hasReasoning,
    hasNoProviderGate: Boolean(hasNoProviderGate),
  };
}

function toShellMessage(m: ConversationMessage): ShellMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.text,
    createdAt: m.timestamp,
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.failureKind ? { failureKind: m.failureKind } : {}),
    ...(m.secretRequest ? { secretRequest: m.secretRequest } : {}),
  };
}

const SECRET_REQUEST: ConversationSecretRequest = {
  key: "OPENAI_API_KEY",
  reason: "to call the model",
  status: "pending",
};

let nextId = 0;
function assistant(
  text: string,
  extra: Partial<ConversationMessage> = {},
): ConversationMessage {
  nextId += 1;
  return {
    id: `msg-${nextId}`,
    role: "assistant",
    text,
    timestamp: nextId,
    ...extra,
  };
}

// A shared corpus exercising every structural affordance both surfaces render.
const CORPUS: Array<{ name: string; message: ConversationMessage }> = [
  {
    name: "plain prose",
    message: assistant("Just a normal reply, nothing rich."),
  },
  {
    name: "fenced code block",
    message: assistant(
      "Here is the patch:\n```ts\nconst x = 1;\n```\nApply it.",
    ),
  },
  {
    name: "two code blocks",
    message: assistant(
      "First:\n```sh\nbun install\n```\nThen:\n```sh\nbun run build\n```",
    ),
  },
  {
    name: "choice widget",
    message: assistant(
      "Pick a plan:\n[CHOICE:plan]\nfree=Free\npro=Pro\n[/CHOICE]",
    ),
  },
  {
    name: "prose + code + choice together",
    message: assistant(
      "Run this:\n```sh\nbun run dev\n```\nThen choose:\n[CHOICE:env]\nlocal=Local\ncloud=Cloud\n[/CHOICE]",
    ),
  },
  {
    name: "reasoning block (multi-segment)",
    // Reasoning renders alongside rich segments on both surfaces; a code block
    // makes the message multi-segment so MessageContent's reasoning branch (not
    // its single-text fast path) runs — the apples-to-apples reasoning case.
    message: assistant("The answer is:\n```txt\n42\n```", {
      reasoning: "I considered several options and settled on 42.",
    }),
  },
  {
    name: "reasoning + code",
    message: assistant("Use this:\n```py\nprint(42)\n```", {
      reasoning: "Python is the simplest demonstration here.",
    }),
  },
  {
    name: "secret request",
    message: assistant("I need a key to continue.", {
      secretRequest: SECRET_REQUEST,
    }),
  },
  {
    name: "no_provider failure gate",
    message: assistant("No model provider is configured.", {
      failureKind: "no_provider",
    }),
  },
];

describe("chat render parity (ThreadLine vs MessageContent) — #9954", () => {
  beforeEach(() => {
    clientMock.getPlugins.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
    vi.clearAllMocks();
  });

  for (const { name, message } of CORPUS) {
    it(`renders the same structure on both surfaces: ${name}`, () => {
      const view = withApp(<MessageContent message={message} />);
      const viewPrint = fingerprint(view.container);
      cleanup();

      const overlay = withApp(
        __renderThreadLineForParity(toShellMessage(message)),
      );
      const overlayPrint = fingerprint(overlay.container);

      expect(overlayPrint).toEqual(viewPrint);
    });
  }

  it("the corpus actually exercises every affordance (guards against an empty/no-op parity check)", () => {
    const seen = new Set<string>();
    for (const { message } of CORPUS) {
      const view = withApp(<MessageContent message={message} />);
      const fp = fingerprint(view.container);
      if (fp.hasChoiceWidget) seen.add("choice");
      if (fp.hasCodeBlock) seen.add("code");
      if (fp.hasReasoning) seen.add("reasoning");
      if (fp.hasSecretRequest) seen.add("secret");
      if (fp.hasNoProviderGate) seen.add("no-provider");
      cleanup();
    }
    // If the corpus stopped covering an affordance the parity check would pass
    // trivially — assert all five rich structures actually appear.
    expect([...seen].sort()).toEqual(
      ["choice", "code", "no-provider", "reasoning", "secret"].sort(),
    );
  });
});
