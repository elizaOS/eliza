/** Strict JSON/YAML rule parsing rejects ambiguous or expandable documents. */
import { describe, expect, it } from "vitest";
import { parseDeletionRulesDocument } from "./delete-files.ts";

const validYaml = `
schemaVersion: 1
rulesetVersion: delete-v1
attachmentPolicy:
  embeddedBytes: drop
  retainMetadata: [filename, mimeType, sha256]
rules:
  - id: receipts
    enabled: true
    scope: message
    match:
      type: label
      value: Receipts
`;

describe("deletion rule documents", () => {
  it("parses explicit YAML through the strict shared schema", () => {
    const rules = parseDeletionRulesDocument(validYaml, "delete-rules.yaml");

    expect(rules.rules).toHaveLength(1);
    expect(rules.rules[0]?.id).toBe("receipts");
  });

  it.each([
    [
      "duplicate keys",
      validYaml.replace("enabled: true", "enabled: true\n    enabled: false"),
    ],
    [
      "anchors",
      validYaml.replace(
        "rulesetVersion: delete-v1",
        "rulesetVersion: &version delete-v1",
      ),
    ],
    ["aliases", `${validYaml}\ncopy: *version\n`],
    ["merge keys", `${validYaml}\nmerged:\n  <<: {extra: true}\n`],
    [
      "custom tags",
      validYaml.replace(
        "rulesetVersion: delete-v1",
        "rulesetVersion: !owner delete-v1",
      ),
    ],
  ])("rejects YAML %s", (_name, source) => {
    expect(() => parseDeletionRulesDocument(source, "rules.yaml")).toThrow();
  });

  it("rejects schema fields that owner review did not define", () => {
    const source = JSON.stringify({
      schemaVersion: 1,
      rulesetVersion: "delete-v1",
      attachmentPolicy: {
        embeddedBytes: "drop",
        retainMetadata: ["filename", "mimeType", "sha256"],
      },
      rules: [],
      fallback: "keep",
    });

    expect(() => parseDeletionRulesDocument(source, "rules.json")).toThrow();
  });
});
