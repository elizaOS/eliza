import { describe, expect, it } from "vitest";
import {
  PARENT_AGENT_DIRECTIVE_MARKER,
  takeParentAgentDirective,
} from "../services/parent-agent-dispatch.js";

const TAIL = 64;
const MENTION =
  "I can ask the parent Eliza agent via the parent-agent bridge (USE_SKILL parent-agent).\n";
const MALFORMED =
  'USE_SKILL parent-agent {"mode":"cloud-command","command":"apps.create","params":{...}}\n';
const DIRECTIVE = 'USE_SKILL parent-agent {"mode":"list-cloud-commands"}';

describe("takeParentAgentDirective", () => {
  it("finds a directive after a prose mention and a malformed one", () => {
    const take = takeParentAgentDirective(
      `${MENTION}${MALFORMED}${DIRECTIVE}\nDone.`,
      TAIL,
    );
    expect(take.directive?.args).toEqual({ mode: "list-cloud-commands" });
    expect(take.rest).toBe("\nDone.");
  });

  it("drops markers that are not directives from the rest", () => {
    for (const text of [MENTION, MALFORMED, `${MALFORMED}${MENTION}`]) {
      const take = takeParentAgentDirective(text, TAIL);
      expect(take.directive).toBeNull();
      expect(take.rest).not.toContain(PARENT_AGENT_DIRECTIVE_MARKER);
      expect(take.rest.length).toBeLessThanOrEqual(TAIL);
    }
  });

  it("keeps a directive that is still streaming from its marker", () => {
    const head = 'USE_SKILL parent-agent {"mode":"list-cl';
    const take = takeParentAgentDirective(`${MALFORMED}${head}`, TAIL);
    expect(take.directive).toBeNull();
    expect(take.rest).toBe(head);
    const done = takeParentAgentDirective(`${take.rest}oud-commands"}`, TAIL);
    expect(done.directive?.args).toEqual({ mode: "list-cloud-commands" });
    expect(done.rest).toBe("");
  });

  it("keeps a marker split across chunks after a dropped marker", () => {
    const take = takeParentAgentDirective(`${MENTION}USE_SKILL par`, TAIL);
    expect(take.directive).toBeNull();
    expect(take.rest.endsWith("USE_SKILL par")).toBe(true);
    const done = takeParentAgentDirective(
      `${take.rest}ent-agent {"mode":"list-cloud-commands"}`,
      TAIL,
    );
    expect(done.directive?.args).toEqual({ mode: "list-cloud-commands" });
  });
});
