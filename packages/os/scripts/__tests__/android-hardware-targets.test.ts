import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("physical Android target inventory stays fail-closed", () => {
  const inventory = JSON.parse(
    readFileSync(`${repositoryRoot}/android/hardware-targets.json`, "utf8"),
  );
  const products = readFileSync(
    `${repositoryRoot}/android/vendor/eliza/AndroidProducts.mk`,
    "utf8",
  );
  const pixel = inventory.targets.find((target) =>
    target.codenames?.includes("tegu"),
  );
  const lightPhone = inventory.targets.find((target) =>
    target.codenames?.includes("TLP301"),
  );
  const pixel11Pro = inventory.targets.find((target) =>
    target.codenames?.includes("grizzly"),
  );

  expect(pixel).toMatchObject({
    targetId: "pixel9a-tegu",
    sourceStatus: "pinned",
    productName: "eliza_tegu_phone",
    installerEligible: false,
  });
  expect(pixel.blockedReasons).toContainEqual(
    expect.stringContaining("Gemma ASR artifact"),
  );
  expect(products).toContain("eliza_tegu_phone-trunk_staging-userdebug");
  expect(pixel11Pro).toMatchObject({
    targetId: "pixel11pro-grizzly",
    sourceStatus: "pinned-generated",
    productName: "eliza_grizzly_phone",
    installerEligible: false,
  });
  expect(pixel11Pro.blockedReasons).toContainEqual(
    expect.stringContaining("stock kernel"),
  );
  expect(products).toContain("eliza_grizzly_phone-trunk_staging-userdebug");
  expect(lightPhone).toMatchObject({
    targetId: "lightphone3-tlp301",
    sourceStatus: "blocked",
    installerEligible: false,
  });
  expect(products).not.toMatch(/TLP301|light[_-]?phone/i);
});
