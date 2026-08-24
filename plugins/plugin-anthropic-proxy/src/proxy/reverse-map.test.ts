/**
 * Unit tests for reverseMap pipeline: validates composition of tool renames,
 * property renames, and string replacements.
 */
import { describe, expect, it } from "vitest";
import { type ReverseMapConfig, reverseMap } from "./reverse-map.ts";

describe("reverse-map", () => {
  it("executes multi-stage reverse mapping accurately", () => {
    const config: ReverseMapConfig = {
      toolRenames: [["OriginalTool", "renamed_tool"]],
      propRenames: [["originalProp", "renamed_prop"]],
      reverseMap: [["original_string", "replacement_string"]],
    };

    const input = '{"tool": "renamed_tool", "param": "renamed_prop", "desc": "original_string"}';
    const result = reverseMap(input, config);

    expect(result).toBe(
      '{"tool": "OriginalTool", "param": "originalProp", "desc": "replacement_string"}'
    );
  });
});
