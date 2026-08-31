/** Deterministic tests for generated meta-system file drift detection. */
import { describe, expect, it } from "vitest";
import {
  assertGeneratedGroupContents,
  checkGeneratedSystemFiles,
} from "../check-generated-system-files.mjs";

describe("assertGeneratedGroupContents", () => {
  const group = {
    id: "fixture",
    source: "source",
    generated: ["copy-a", "copy-b"],
  };

  it("accepts byte-identical generated files", () => {
    expect(() =>
      assertGeneratedGroupContents(group, () => Buffer.from("canonical")),
    ).not.toThrow();
  });

  it("names the drifted output and canonical source", () => {
    expect(() =>
      assertGeneratedGroupContents(group, (file) =>
        Buffer.from(file === "copy-b" ? "drift" : "canonical"),
      ),
    ).toThrow("copy-b drifted from generated source source");
  });
});

describe("checkGeneratedSystemFiles", () => {
  it("reports native Capacitor drift through the standard verification path", () => {
    expect(() =>
      checkGeneratedSystemFiles(() => [
        "plugins/plugin-native-phone/rollup.config.mjs",
      ]),
    ).toThrow(
      "Native Capacitor scaffold drifted:\n- plugins/plugin-native-phone/rollup.config.mjs",
    );
  });
});
