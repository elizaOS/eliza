import { describe, expect, it } from "vitest";

import { AssistantOverlay } from "../AssistantOverlay";
import { ChatSurface } from "../ChatSurface";
import { HomePill } from "../HomePill";

describe("shell exports", () => {
  it("exposes the shell-foundation public API", () => {
    expect(typeof AssistantOverlay).toBe("function");
    expect(typeof ChatSurface).toBe("function");
    expect(typeof HomePill).toBe("function");
  });
});
