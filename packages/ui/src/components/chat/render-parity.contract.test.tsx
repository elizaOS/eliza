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

// MessageContent (ChatView path) and ThreadLine (overlay path) both render real
// inline widgets; import them after the mocks are in place.
import { __renderThreadLineForParity } from "../shell/ContinuousChatOverlay";
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
  hasInlineCode: boolean;
  inlineCodeCount: number;
  hasSecretRequest: boolean;
  hasReasoning: boolean;
  hasNoProviderGate: boolean;
}

function normalizeChoiceTestId(id: string): string {
  return id
    .replace(
      /^choice-shell-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-(?:body|chevron))?$/i,
      "choice-shell-<generated>$1",
    )
    .replace(
      /^choice-shell-choice-[a-z0-9]+-[a-z0-9]+(-(?:body|chevron))?$/i,
      "choice-shell-<generated>$1",
    );
}

function fingerprint(root: HTMLElement): StructuralFingerprint {
  const choiceOptions = Array.from(
    root.querySelectorAll('[data-testid^="choice-"]'),
  )
    .map((el) => el.getAttribute("data-testid") ?? "")
    .filter((id) => id.startsWith("choice-") && !id.startsWith("choice-custom"))
    .map(normalizeChoiceTestId)
    .sort();
  const codeBlocks = root.querySelectorAll('[data-testid="code-block"]');
  // Inline `` `code` `` spans lift to the inline code primitive (a distinct
  // testid from block-level fences). Tracked so the inline-code divergence
  // between the two surfaces can be pinned, not silently drift.
  const inlineCode = root.querySelectorAll('[data-testid="inline-code"]');
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
    hasInlineCode: inlineCode.length > 0,
    inlineCodeCount: inlineCode.length,
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
    name: "reasoning block (single text segment)",
    message: assistant("You're free after 3pm.", {
      reasoning: "I checked the calendar and the afternoon is open.",
    }),
  },
  {
    name: "reasoning block (multi-segment)",
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

/**
 * Render the same message through BOTH surfaces and return each one's structural
 * fingerprint: MessageContent (the ChatView path) and ThreadLine (the overlay
 * path, via the `__renderThreadLineForParity` seam). Cleans up between and after
 * so the two trees never coexist in the jsdom document.
 */
function renderBoth(message: ConversationMessage): {
  viewPrint: StructuralFingerprint;
  overlayPrint: StructuralFingerprint;
} {
  const view = withApp(<MessageContent message={message} />);
  const viewPrint = fingerprint(view.container);
  cleanup();
  const overlay = withApp(__renderThreadLineForParity(toShellMessage(message)));
  const overlayPrint = fingerprint(overlay.container);
  cleanup();
  return { viewPrint, overlayPrint };
}

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
      const { viewPrint, overlayPrint } = renderBoth(message);
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

// ── PINNED divergences ──────────────────────────────────────────────────────
//
// The two surfaces DO legitimately diverge in two structural ways today. These
// are pinned (not "fixed" here) so each is a CONSCIOUS contract: the only way to
// reconcile a surface is to flip the assertion in this file, never a silent edit
// to one switch statement. Mirrors how parser-parity.contract.test.ts pins the
// FORM-marker regex asymmetry with an explicit, commented expectation.
describe("chat render parity — PINNED divergences (intended/tracked) — #9954 item 7", () => {
  beforeEach(() => {
    clientMock.getPlugins.mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    __setAppValueForTests(null);
    vi.clearAllMocks();
  });

  // (1) Inline `` `code` ``. ChatView's MessageTextBody lifts each backtick span
  //     into the inline code primitive (data-testid="inline-code"); the overlay's
  //     InlineWidgetText keeps a single-text segment literal in a plain <span>, so
  //     the backticks render as prose. Diverges whenever a text run holds inline
  //     code. (ChatView shows the richer inline affordance; the overlay keeps
  //     transcript prose minimal — intended.)
  it("PIN: inline `code` lifts to the inline code primitive in ChatView, stays literal in the overlay", () => {
    const { viewPrint, overlayPrint } = renderBoth(
      assistant("Run `npm install` then `npm run dev` to start."),
    );
    expect(viewPrint.inlineCodeCount).toBe(2);
    expect(viewPrint.hasInlineCode).toBe(true);
    expect(overlayPrint.inlineCodeCount).toBe(0);
    expect(overlayPrint.hasInlineCode).toBe(false);
  });

  // (2) Secret request with a rich body + reasoning. MessageContent early-returns
  //     ONLY the SensitiveRequestBlock — body code/widgets and reasoning are
  //     suppressed. ThreadLine co-renders the body (so a fenced block still shows
  //     a code block), the secret block, AND reasoning. Both emit exactly one
  //     sensitive-request (agreement); the surrounding body is what diverges.
  it("PIN: a secret request suppresses the body in ChatView, co-renders it in the overlay", () => {
    const { viewPrint, overlayPrint } = renderBoth(
      assistant("Paste the token:\n```ts\nconst t = 1;\n```", {
        reasoning: "Explaining why the key is needed before I ask for it.",
        secretRequest: SECRET_REQUEST,
      }),
    );
    expect(viewPrint).toMatchObject({
      hasSecretRequest: true,
      hasCodeBlock: false,
      hasReasoning: false,
    });
    expect(overlayPrint).toMatchObject({
      hasSecretRequest: true,
      hasCodeBlock: true,
      hasReasoning: true,
    });
  });
});
