/**
 * Core's secret format table ships in the web protocol chunk of the Play
 * cloud build, so its placeholders must pass the packaged text asset audit.
 */
import { describe, expect, it } from "vitest";
import { SECRET_VALIDATION_PATTERNS } from "../../../core/src/validation/secrets.ts";
import { findAndroidPlayTextAssetFindings } from "../mobile/android/cloud-policy.ts";

const asset = "base/assets/public/assets/protocol.js";
const audit = (source: string) =>
  findAndroidPlayTextAssetFindings([asset], [Buffer.from(source)]);

describe("core secret format examples in the Play text asset audit", () => {
  it.each(Object.entries(SECRET_VALIDATION_PATTERNS))(
    "%s example is not read as a credential",
    (_key, { example }) => {
      expect(audit(`example:${JSON.stringify(example ?? "")}`)).toEqual([]);
    },
  );

  it("still flags credential-shaped keys", () => {
    expect(audit(`"AIza${"A".repeat(35)}"`)).toEqual([
      `${asset}: Google API key`,
    ]);
    expect(audit(`"sk-proj-${"a".repeat(24)}"`)).toEqual([
      `${asset}: provider secret`,
    ]);
  });
});
