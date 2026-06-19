import { describe, expect, it } from "vitest";
import { gitPathologyAction } from "../src/actions/git-pathology.ts";

const runtimeWithService = {
  getService: () => ({}),
} as never;

function message(text: string, params?: Record<string, unknown>) {
  return {
    content: {
      text,
      ...(params ? { params } : {}),
    },
  } as never;
}

describe("gitPathologyAction validation", () => {
  it("does not claim broad non-git 'when did' questions", async () => {
    await expect(
      gitPathologyAction.validate?.(
        runtimeWithService,
        message("when did we decide on the launch name?")
      )
    ).resolves.toBe(false);
  });

  it("claims code-history prompts and explicit params", async () => {
    await expect(
      gitPathologyAction.validate?.(
        runtimeWithService,
        message("when did this module start to rot?")
      )
    ).resolves.toBe(true);
    await expect(
      gitPathologyAction.validate?.(
        runtimeWithService,
        message("please analyze", { surface: "src" })
      )
    ).resolves.toBe(true);
  });
});
