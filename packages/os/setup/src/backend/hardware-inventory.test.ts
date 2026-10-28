import { expect, test } from "vitest";
import inventory from "../../../android/hardware-targets.json";
import product from "../../../android/products/pixel10a-eliza.json";
import { parseHardwareTargets } from "./adb-backend";

test("the shared Pixel source is parseable without granting installation eligibility", () => {
  const target = parseHardwareTargets(inventory).find(
    (entry) => entry.targetId === "pixel10a-stallion",
  );
  expect(target).toMatchObject({
    productName: product.productName,
    expectedFingerprintPrefix: `${product.brand}/${product.productName}/stallion:`,
    sourceStatus: "pinned-generated",
    installerEligible: false,
  });
  expect(() =>
    parseHardwareTargets({
      schemaVersion: 1,
      targets: [{ ...target, productName: undefined }],
    }),
  ).toThrow("invalid target");
});
