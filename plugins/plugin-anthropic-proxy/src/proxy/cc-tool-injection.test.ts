import { describe, expect, it } from "vitest";
import { processToolsSection } from "./cc-tool-injection";
import { CC_SYNTHETIC_TOOLS } from "./constants";

const TOOLS_JSON = CC_SYNTHETIC_TOOLS.join(",");

function bodyWithTools(toolsArray: string): string {
  return `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}],"tools":[${toolsArray}]}`;
}

describe("processToolsSection bracket matching", () => {
  it("passes through bodies without a tools key", () => {
    const m = '{"model":"x","messages":[]}';
    expect(processToolsSection(m, true, false)).toEqual({
      body: m,
      descriptionsStripped: 0,
      syntheticToolsInjected: 0,
    });
  });

  it("does not treat the ']' inside a description string as the array close", () => {
    const m = bodyWithTools('{"name":"a","description":"has ] bracket"}');
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    // description value removed, trailing content (the } and real close) intact
    expect(r.body).toContain('"name":"a"');
    expect(r.body).not.toContain("has ] bracket");
    expect(r.body).toMatch(/"tools":\[\{"name":"a","description":""\}\]\}$/);
  });

  it("skips '[' inside string values when matching depth", () => {
    const m = bodyWithTools('{"name":"a","description":"[ not depth"}');
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.body).toMatch(/"tools":\[\{"name":"a","description":""\}\]\}$/);
  });

  it("handles escaped quotes inside description values", () => {
    const m = bodyWithTools('{"name":"a","description":"say \\"hi\\" ok"}');
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.body).toMatch(/"tools":\[\{"name":"a","description":""\}\]\}$/);
  });

  it("handles backslash-escaped backslashes before quotes", () => {
    const m = bodyWithTools('{"name":"a","description":"path \\\\ then \\"q\\""}');
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.body).toMatch(/"tools":\[\{"name":"a","description":""\}\]\}$/);
  });

  it("returns the body untouched when the tools array is unbalanced", () => {
    const m = '{"model":"x","tools":[{"name":"a","description":"d"}';
    const r = processToolsSection(m, true, false);
    expect(r).toEqual({
      body: m,
      descriptionsStripped: 0,
      syntheticToolsInjected: 0,
    });
  });

  it("strips nothing from an empty tools array", () => {
    const m = bodyWithTools("");
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(0);
    expect(r.body).toContain('"tools":[]');
  });

  it("strips multiple descriptions in one pass", () => {
    const m = bodyWithTools(`${TOOLS_JSON},${TOOLS_JSON}`);
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(2 * CC_SYNTHETIC_TOOLS.length);
  });
});

describe("processToolsSection synthetic injection", () => {
  it("injects synthetic tools right after the tools array open", () => {
    const m = bodyWithTools('{"name":"a"}');
    const r = processToolsSection(m, false, true);
    expect(r.syntheticToolsInjected).toBe(CC_SYNTHETIC_TOOLS.length);
    expect(r.body).toBe(
      `{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}],"tools":[${TOOLS_JSON},{"name":"a"}]}`
    );
  });

  it("strips and injects together", () => {
    const m = bodyWithTools('{"name":"a","description":"d"}');
    const r = processToolsSection(m, true, true);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.syntheticToolsInjected).toBe(CC_SYNTHETIC_TOOLS.length);
    expect(r.body).toContain(CC_SYNTHETIC_TOOLS[0]);
    expect(r.body).not.toContain('"description":"d"');
  });

  it("injects nothing when the body has no tools key", () => {
    const m = '{"model":"x"}';
    const r = processToolsSection(m, false, true);
    expect(r.syntheticToolsInjected).toBe(0);
    expect(r.body).toBe(m);
  });
});

describe("processToolsSection tools-key discovery", () => {
  it("does not mistake a literal tools array inside message content for the real key", () => {
    // A user message pasting example JSON that itself contains '"tools":[...]'
    // must not be mistaken for the real tools section.
    const m =
      '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"example: \\"tools\\":[{\\"name\\":\\"fake\\"}] inside text"}],"tools":[{"name":"real","description":"real description"}]}';
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.body).toContain("fake");
    expect(r.body).not.toContain('"description":"real description"');
    expect(r.body).toMatch(/"tools":\[\{"name":"real","description":""\}\]\}$/);
  });

  it("keeps a description that contains the literal 'tools' open sequence intact when stripping siblings", () => {
    const m = bodyWithTools(
      '{"name":"a","description":"contains \\"tools\\":[ literal"},{"name":"b","description":"second"}'
    );
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(2);
    expect(r.body).toContain('"description":""');
    expect(r.body).not.toContain("second");
  });

  it("strips descriptions when the tools key has whitespace around the colon", () => {
    // Non-canonical spacing must not cause a silent pass-through that leaks
    // tool descriptions into the transformed request.
    const m = '{"model":"x","messages":[],"tools" : [{"name":"a","description":"secret"}]}';
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.body).not.toContain("secret");
    expect(r.body).toMatch(/"tools" : \[\{"name":"a","description":""\}\]\}$/);
  });

  it("finds the tools key across a newline-separated colon", () => {
    const m = '{"model":"x","messages":[],"tools":\n[{"name":"a","description":"secret"}]}';
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.body).not.toContain("secret");
    expect(r.body).toMatch(/"tools":\n\[\{"name":"a","description":""\}\]\}$/);
  });

  it("injects synthetic tools when the key is non-canonically spaced", () => {
    const m = '{"model":"x","tools" : [{"name":"a"}]}';
    const r = processToolsSection(m, false, true);
    expect(r.syntheticToolsInjected).toBe(CC_SYNTHETIC_TOOLS.length);
    expect(r.body).toBe(`{"model":"x","tools" : [${TOOLS_JSON},{"name":"a"}]}`);
  });

  it("does not treat a 'tools' property name inside a tool schema as the array open", () => {
    const m =
      '{"model":"x","tools":[{"name":"a","input_schema":{"type":"object","properties":{"tools":{"type":"array"}}},"description":"d"}]}';
    const r = processToolsSection(m, true, false);
    expect(r.descriptionsStripped).toBe(1);
    expect(r.body).toMatch(
      /"tools":\[\{"name":"a","input_schema":\{"type":"object","properties":\{"tools":\{"type":"array"\}\}\},"description":""\}\]\}$/
    );
  });
});
