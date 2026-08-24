/**
 * Locks the cn() re-export that cloud-ui components and the cloud api-explorer
 * resolve their class merging through. The barrel must stay wired to the
 * registered tailwind-merge instance in src/lib/utils: an unregistered merger
 * parses custom font-size utilities such as `text-chat-body` as text colors
 * and silently drops them whenever a real color class follows.
 */
import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cloud-ui cn() re-export", () => {
  it("keeps registered custom font-size utilities alongside text colors", () => {
    expect(cn("text-chat-body", "text-muted")).toBe(
      "text-chat-body text-muted",
    );
    expect(cn("text-muted", "text-2xs")).toBe("text-muted text-2xs");
  });

  it("resolves conflicting utilities last-wins through the re-export", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", "text-chat-body")).toBe("text-chat-body");
  });

  it("flattens clsx conditional and array inputs before merging", () => {
    expect(cn("base", false && "hidden", undefined, ["a", "b"])).toBe(
      "base a b",
    );
  });
});
