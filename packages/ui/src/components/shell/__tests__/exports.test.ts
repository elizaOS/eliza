import { describe, expect, it } from "vitest";

import { AssistantOverlay } from "../AssistantOverlay";
import { ChatSurface } from "../ChatSurface";
import { HomePill } from "../HomePill";
import { initialShellState, shellReducer } from "../shell-state";
import { useShellState } from "../useShellState";

describe("shell exports", () => {
  it("exposes the shell-foundation public API", () => {
    expect(typeof AssistantOverlay).toBe("function");
    expect(typeof ChatSurface).toBe("function");
    expect(typeof HomePill).toBe("function");
    expect(typeof shellReducer).toBe("function");
    expect(typeof useShellState).toBe("function");
    expect(initialShellState.phase).toBe("booting");
  });
});
