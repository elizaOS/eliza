/** Learning starts in the visible composer and never silently sends a message. */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CHAT_PREFILL_EVENT } from "../../events";

const clientMock = vi.hoisted(() => ({
  fetch: vi.fn(),
  sendChatMessage: vi.fn(),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../hooks/useFetchData", () => ({
  useFetchData: () => ({ status: "success", data: [], refetch: vi.fn() }),
}));
vi.mock("../../agent-surface/useAgentElement", () => ({
  useAgentElement: () => ({}),
}));

import { CharacterLearnedSkillsSection } from "./CharacterLearnedSkillsSection";

afterEach(cleanup);

it("opens an editable skill-learning draft without a background send", () => {
  const listener = vi.fn();
  window.addEventListener(CHAT_PREFILL_EVENT, listener);
  try {
    render(<CharacterLearnedSkillsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Learn a skill" }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      text: "Help me learn a new skill. Ask what capability I want to practice.",
    });
    expect(clientMock.sendChatMessage).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener(CHAT_PREFILL_EVENT, listener);
  }
});
