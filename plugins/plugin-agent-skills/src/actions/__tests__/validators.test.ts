import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getService: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({}));
vi.mock("../services/skills", () => ({}));

import { createAgentSkillsActionValidator } from "./validators.ts";

describe("createAgentSkillsActionValidator", () => {
  it("returns true when the skills service is registered", async () => {
    mocks.getService.mockReturnValue({});
    const validate = createAgentSkillsActionValidator();
    const runtime = { getService: mocks.getService } as never;
    await expect(validate(runtime)).resolves.toBe(true);
    expect(mocks.getService).toHaveBeenCalledWith("AGENT_SKILLS_SERVICE");
  });

  it("returns false when the service is missing", async () => {
    mocks.getService.mockReturnValue(null);
    const validate = createAgentSkillsActionValidator();
    await expect(validate({ getService: mocks.getService } as never)).resolves.toBe(
      false,
    );
  });

  it("fails closed when getService throws", async () => {
    mocks.getService.mockImplementation(() => {
      throw new Error("boom");
    });
    const validate = createAgentSkillsActionValidator();
    await expect(validate({ getService: mocks.getService } as never)).resolves.toBe(
      false,
    );
  });
});
