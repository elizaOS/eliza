// @vitest-environment jsdom
/** Reader interactions preserve recorded evidence; transport and clipboard are mocked. */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../api/client-types-chat";
import type {
  TrajectoryDetailResult,
  TrajectoryLlmCall,
  TrajectoryRecord,
} from "../../api/client-types-cloud";
import { DeveloperReader, TrajectoryReader } from "./DeveloperReader";

const mocks = vi.hoisted(() => ({
  copy: vi.fn(),
  list: vi.fn(),
  detail: vi.fn(),
}));
vi.mock("../../api/client", () => ({
  client: { getTrajectories: mocks.list, getTrajectoryDetail: mocks.detail },
}));
vi.mock("../../state/app-store", () => ({
  useAppSelector: (
    select: (state: { copyToClipboard: typeof mocks.copy }) => unknown,
  ) => select({ copyToClipboard: mocks.copy }),
}));

const record: TrajectoryRecord = {
  id: "reader-run",
  agentId: "fixture-agent",
  entityId: null,
  roomId: "reader-room",
  conversationId: "reader-conversation",
  source: "client_chat",
  status: "completed",
  startTime: 1000,
  endTime: 2500,
  durationMs: 1500,
  llmCallCount: 1,
  providerAccessCount: 1,
  totalPromptTokens: 100,
  totalCompletionTokens: 20,
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:00:02Z",
  metadata: { messageId: "request-1" },
};
const system =
  "Preamble 🦉\r\n# Character\r\nKeep every value.  \r\n# Current request\nRead the note.\n";
const input = "Exact current message: keep the final period.";
const response =
  '{"messageToUser":"The saved text ends with a period.","completed":true}';
const call: TrajectoryLlmCall = {
  id: "reader-call",
  trajectoryId: record.id,
  stepId: "model-step",
  timestamp: 1100,
  model: "synthetic-model",
  provider: "synthetic-provider",
  purpose: "action_planner",
  actionType: "REPLY",
  temperature: 0,
  maxTokens: 0,
  latencyMs: 700,
  createdAt: record.createdAt,
  promptTokens: 100,
  completionTokens: 20,
  cacheReadInputTokens: 40,
  systemPrompt: system,
  messages: [{ role: "user", content: input }],
  userPrompt: `${system}\n${input}`,
  tools: {
    NOTES_READ: {
      description: "Read a saved note",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
    },
  },
  toolChoice: "auto",
  response,
  toolCalls: [{ name: "NOTES_READ", args: { id: "note-1" } }],
};
const detail: TrajectoryDetailResult = {
  trajectory: record,
  payloadsIncluded: true,
  llmCalls: [call],
  providerAccesses: [
    {
      id: "provider-1",
      trajectoryId: record.id,
      stepId: "context-step",
      timestamp: 1000,
      createdAt: record.createdAt,
      providerName: "SAVED_NOTES",
      purpose: "state_composition",
      query: { message: "Read the note." },
      data: { text: "Provider-only text never included in this model input." },
    },
  ],
  semanticStages: [
    {
      schemaVersion: 1,
      stageId: "read-note-step",
      kind: "tool",
      startedAt: 1800,
      endedAt: 1900,
      latencyMs: 100,
      payload: {
        tool: {
          name: "NOTES_READ",
          args: { id: "note-1", exact: "Line one\nLine two." },
          result: { success: true, content: "Full saved note 🦉." },
        },
      },
    },
  ],
};

const content = () => screen.getByRole("region", { name: "Recorded content" });
const choose = (value: string) =>
  fireEvent.change(screen.getByLabelText("Content"), { target: { value } });
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  mocks.copy.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue({
    trajectories: [],
    total: 0,
    offset: 0,
    limit: 100,
  });
  mocks.detail.mockResolvedValue(detail);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("recorded trajectory reader", () => {
  it("switches complete model inputs and outputs without issuing payload requests", () => {
    render(<TrajectoryReader detail={detail} />);
    expect(content().textContent).toBe(system);
    choose("messages[0]");
    expect(content().textContent).toBe(input);
    click("Output");
    expect(
      within(content()).getByText("The saved text ends with a period."),
    ).toBeTruthy();
    click("Raw text");
    expect(content().textContent).toBe(response);
    click("Input");
    expect(content().textContent).toBe(system);
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("copies exact text and a source reference without normalizing whitespace or Unicode", async () => {
    render(<TrajectoryReader detail={detail} />);
    click("Copy text");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(system);
    click("Copy reference");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(
      `Run reader-run\n1. Action planner\nsystemPrompt\n\n${system}`,
    );
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("jumps to one section and restores all text, retaining exact offset references", async () => {
    render(<TrajectoryReader detail={detail} />);
    click("Find");
    fireEvent.change(screen.getByLabelText("Find a section"), {
      target: { value: "saved-value-not-present" },
    });
    expect(
      screen.getByText("0 matching sections. Select one to read it."),
    ).toBeTruthy();
    expect(content().textContent).toBe(system);
    fireEvent.change(screen.getByLabelText("Find a section"), {
      target: { value: "Current request" },
    });
    const jump = screen.getByLabelText("Jump to section");
    const option = within(jump).getByRole("option", {
      name: /Current request/,
    });
    fireEvent.change(jump, { target: { value: option.getAttribute("value") } });
    const start = system.indexOf("# Current request");
    expect(content().textContent).toBe(system.slice(start));
    click("Copy reference");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(
      `Run reader-run\n1. Action planner\nsystemPrompt [characters ${start}–${system.length})\n\n${system.slice(start)}`,
    );
    fireEvent.change(jump, { target: { value: "-1" } });
    expect(content().textContent).toBe(system);
    click("Copy text");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(system);
  });

  it("resets a selected section when the filter changes, preserving all recorded text", async () => {
    render(<TrajectoryReader detail={detail} />);
    expect(screen.queryByLabelText("Find a section")).toBeNull();
    click("Find");
    const jump = screen.getByLabelText("Jump to section");
    const currentRequest = within(jump).getByRole("option", {
      name: /Current request/,
    });
    fireEvent.change(jump, {
      target: { value: currentRequest.getAttribute("value") },
    });
    expect(content().textContent).toBe(
      system.slice(system.indexOf("# Current request")),
    );

    fireEvent.change(screen.getByLabelText("Find a section"), {
      target: { value: "Character" },
    });
    expect((jump as HTMLSelectElement).value).toBe("-1");
    expect(
      within(jump).queryByRole("option", { name: /Current request/ }),
    ).toBeNull();
    expect(
      within(jump).getByRole("option", { name: /^Character/ }),
    ).toBeTruthy();
    expect(content().textContent).toBe(system);
    click("Copy text");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(system);

    click("Find");
    expect(screen.queryByLabelText("Find a section")).toBeNull();
    expect(
      within(jump).getByRole("option", { name: /Current request/ }),
    ).toBeTruthy();
    expect(content().textContent).toBe(system);
  });

  it("distinguishes unrecorded payloads and unknown usage from recorded empty values", async () => {
    const unknown = {
      ...call,
      systemPrompt: undefined,
      messages: undefined,
      tools: undefined,
      response: undefined,
      promptTokens: undefined,
      completionTokens: undefined,
      cacheReadInputTokens: undefined,
    };
    const { rerender } = render(
      <TrajectoryReader detail={{ ...detail, llmCalls: [unknown] }} />,
    );
    expect(content().textContent).toContain("This payload was not recorded");
    expect(
      screen.getByText("System prompt · not recorded", { selector: "span" }),
    ).toBeTruthy();
    expect(screen.queryByText("System prompt · 0 characters")).toBeNull();
    expect(
      screen.getByText(/synthetic-model · unknown input · unknown output/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Copy text" })
        .hasAttribute("disabled"),
    ).toBe(true);
    rerender(
      <TrajectoryReader
        detail={{
          ...detail,
          llmCalls: [{ ...call, systemPrompt: "", messages: [], response: "" }],
        }}
      />,
    );
    expect(content().textContent).toBe("Recorded empty value.");
    click("Copy text");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith("");
    choose("messages");
    click("Copy text");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith("[]");
    click("Output");
    expect(content().textContent).toBe("Recorded empty value.");
  });

  it.each([
    ["messages", "[]"],
    ["tools", "{}"],
  ])("shows exact empty %s values in raw view", async (field, expected) => {
    render(
      <TrajectoryReader
        detail={{ ...detail, llmCalls: [{ ...call, messages: [], tools: {} }] }}
      />,
    );
    choose(field);
    expect(content().textContent).toBe("Recorded empty value.");
    click("Raw text");
    expect(content().textContent).toBe(expected);
    expect(within(content()).queryByText("Recorded empty value.")).toBeNull();
    click("Copy text");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(expected);
    click("Readable view");
    expect(content().textContent).toBe("Recorded empty value.");
  });

  it("labels provider output as intermediate context and keeps it separate from model input", async () => {
    render(<TrajectoryReader detail={detail} />);
    expect(content().textContent).not.toContain("Provider-only");
    click("Providers");
    expect(content().textContent).toBe(detail.providerAccesses[0].data.text);
    expect(
      screen.getByText(
        /Only a model call’s recorded input proves what it received/,
      ),
    ).toBeTruthy();
    click("Input");
    click("Copy text");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(
      JSON.stringify(detail.providerAccesses[0].query, null, 2),
    );
    click("Model calls");
    choose("messages[0]");
    expect(content().textContent).toBe(input);
  });

  it("shows action arguments and results while labeling step wrappers as non-additional usage", async () => {
    render(<TrajectoryReader detail={detail} />);
    click("Steps & actions");
    expect(
      screen.getByRole("heading", { name: "1. tool · NOTES_READ" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/they are not additional token usage/),
    ).toBeTruthy();
    click("Copy text");
    await flush();
    expect(JSON.parse(mocks.copy.mock.calls.at(-1)?.[0])).toEqual({
      id: "note-1",
      exact: "Line one\nLine two.",
    });
    click("Output");
    expect(within(content()).getByText("Full saved note 🦉.")).toBeTruthy();
    click("Copy text");
    await flush();
    expect(JSON.parse(mocks.copy.mock.calls.at(-1)?.[0])).toEqual({
      success: true,
      content: "Full saved note 🦉.",
    });
  });

  it("keeps flattened alternatives inspectable without adding them to the recorded token total", async () => {
    render(<TrajectoryReader detail={detail} />);
    expect(
      screen.getByText(/1 model attempt · 100 input \/ 20 output tokens/),
    ).toBeTruthy();
    const selector = screen.getByLabelText("Content");
    expect(
      within(selector).getByRole("option", {
        name: /Recorded user prompt \(flattened alternative\)/,
      }),
    ).toBeTruthy();
    choose("userPrompt");
    expect(content().textContent).toBe(call.userPrompt);
    expect(
      screen.getByText(/1 model attempt · 100 input \/ 20 output tokens/),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "characters, not tokens",
    );
    click("Copy full run");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(
      JSON.stringify(detail, null, 2),
    );
  });

  it("uses the summary record for run totals without rewriting call usage or raw evidence", async () => {
    render(
      <TrajectoryReader
        detail={detail}
        record={{
          ...record,
          totalPromptTokens: 8890,
          totalCompletionTokens: 381,
          durationMs: 840,
        }}
      />,
    );
    expect(
      screen.getByText(
        /1 model attempt · 8,890 input \/ 381 output tokens · 0.84s server run/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/synthetic-model · 100 input · 20 output/),
    ).toBeTruthy();
    click("Copy full run");
    await flush();
    expect(mocks.copy).toHaveBeenLastCalledWith(
      JSON.stringify(detail, null, 2),
    );
    click("Raw run");
    click("Raw text");
    expect(content().textContent).toBe(JSON.stringify(detail, null, 2));
  });

  it("shows a designed-empty category and retains the full run on demand", () => {
    render(
      <TrajectoryReader
        detail={{
          ...detail,
          llmCalls: [],
          providerAccesses: [],
          semanticStages: [],
        }}
      />,
    );
    expect(
      screen.getByText("No payloads recorded in this category."),
    ).toBeTruthy();
    click("Providers");
    expect(
      screen.getByText("No payloads recorded in this category."),
    ).toBeTruthy();
    click("Raw run");
    expect(within(content()).getByText("reader-run")).toBeTruthy();
  });

  it("reports copy failure without replacing the evidence", async () => {
    mocks.copy.mockRejectedValueOnce(new Error("Clipboard denied"));
    render(<TrajectoryReader detail={detail} />);
    click("Copy text");
    await flush();
    expect(screen.getByRole("status").textContent).toContain("Copy failed");
    expect(content().textContent).toBe(system);
  });
});

describe("live reader ownership", () => {
  it.each(["succeeds", "fails"] as const)(
    "keeps detail and summary together when a revision refresh %s",
    async (outcome) => {
      const initial: TrajectoryRecord = { ...record, status: "active" };
      const initialDetail = { ...detail, trajectory: initial };
      const latest: TrajectoryRecord = {
        ...record,
        llmCallCount: 2,
        totalPromptTokens: 400,
        totalCompletionTokens: 50,
        durationMs: 1800,
        updatedAt: "2026-09-15T12:00:03Z",
      };
      const latestDetail: TrajectoryDetailResult = {
        ...detail,
        trajectory: latest,
        llmCalls: [
          { ...call, systemPrompt: "Refreshed recorded input" },
          {
            ...call,
            id: "second-call",
            promptTokens: 300,
            completionTokens: 30,
          },
        ],
      };
      const pending: {
        resolve: (value: TrajectoryDetailResult) => void;
        reject: (reason: Error) => void;
      }[] = [];
      mocks.detail.mockResolvedValueOnce(initialDetail).mockImplementationOnce(
        () =>
          new Promise<TrajectoryDetailResult>((resolve, reject) => {
            pending.push({ resolve, reject });
          }),
      );
      const props = {
        messages: [
          {
            id: "request-1",
            role: "user" as const,
            text: "Read the note.",
            timestamp: 1000,
          },
        ],
        roomId: record.roomId ?? undefined,
        busy: false,
        error: null,
      };
      const oldSummary =
        /Recorded run · active · 1 model attempt · 100 input \/ 20 output tokens · 1.50s server run/;
      const newSummary =
        /Recorded run · completed · 2 model attempts · 400 input \/ 50 output tokens · 1.80s server run/;
      const updating =
        "Updating recorded payloads… Showing the last loaded version.";
      const { rerender } = render(
        <DeveloperReader {...props} records={[initial]} />,
      );
      await flush();
      expect(content().textContent).toBe(system);
      expect(screen.getByText(oldSummary)).toBeTruthy();

      rerender(<DeveloperReader {...props} records={[latest]} />);
      await flush();
      expect(pending).toHaveLength(1);
      expect(mocks.detail).toHaveBeenCalledTimes(2);
      expect(screen.getByText(updating)).toBeTruthy();
      expect(content().textContent).toBe(system);
      expect(screen.getByText(oldSummary)).toBeTruthy();
      expect(screen.queryByText(/Recorded run · completed/)).toBeNull();
      expect(screen.queryByText(/400 input \/ 50 output tokens/)).toBeNull();
      click("Copy full run");
      await flush();
      expect(mocks.copy).toHaveBeenLastCalledWith(
        JSON.stringify(initialDetail, null, 2),
      );

      await act(async () => {
        if (outcome === "succeeds") pending[0].resolve(latestDetail);
        else pending[0].reject(new Error("Refresh unavailable"));
      });
      expect(screen.queryByText(updating)).toBeNull();
      if (outcome === "succeeds") {
        expect(content().textContent).toBe("Refreshed recorded input");
        expect(screen.getByText(newSummary)).toBeTruthy();
        expect(screen.queryByText(oldSummary)).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
      } else {
        expect(content().textContent).toBe(system);
        expect(screen.getByText(oldSummary)).toBeTruthy();
        expect(screen.queryByText(newSummary)).toBeNull();
        expect(screen.getByRole("alert").textContent).toContain(
          "Couldn’t refresh the recorded inputs. Showing the last loaded version.",
        );
      }
      click("Copy full run");
      await flush();
      expect(mocks.copy).toHaveBeenLastCalledWith(
        JSON.stringify(
          outcome === "succeeds" ? latestDetail : initialDetail,
          null,
          2,
        ),
      );
    },
  );

  it("aborts the previous run read and ignores a stale response after the selected turn changes", async () => {
    const pending = new Map<
      string,
      { resolve: (value: TrajectoryDetailResult) => void; signal: AbortSignal }
    >();
    mocks.detail.mockImplementation(
      (id: string, options: { signal: AbortSignal }) =>
        new Promise<TrajectoryDetailResult>((resolve) =>
          pending.set(id, { resolve, signal: options.signal }),
        ),
    );
    const next = {
      ...record,
      id: "new-run",
      metadata: { messageId: "request-2" },
    };
    const messages: ConversationMessage[] = [
      { id: "request-1", role: "user", text: "First request", timestamp: 1000 },
    ];
    const props = {
      records: [record, next],
      roomId: record.roomId ?? undefined,
      busy: false,
      error: null,
    };
    const { rerender, unmount } = render(
      <DeveloperReader {...props} messages={messages} />,
    );
    await flush();
    expect(pending.get(record.id)?.signal.aborted).toBe(false);
    rerender(
      <DeveloperReader
        {...props}
        messages={[
          ...messages,
          {
            id: "request-2",
            role: "user",
            text: "Second request",
            timestamp: 2000,
          },
        ]}
      />,
    );
    await flush();
    expect(pending.get(record.id)?.signal.aborted).toBe(true);
    expect(pending.get(next.id)?.signal.aborted).toBe(false);
    await act(async () =>
      pending.get(next.id)?.resolve({
        ...detail,
        trajectory: next,
        llmCalls: [{ ...call, id: "new-call", systemPrompt: "New run input" }],
      }),
    );
    expect(content().textContent).toBe("New run input");
    await act(async () => pending.get(record.id)?.resolve(detail));
    expect(content().textContent).toBe("New run input");
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    expect(mocks.detail).toHaveBeenLastCalledWith(
      "new-run",
      expect.objectContaining({ includePayloads: true }),
    );
    unmount();
    expect(pending.get(next.id)?.signal.aborted).toBe(true);
  });
});
