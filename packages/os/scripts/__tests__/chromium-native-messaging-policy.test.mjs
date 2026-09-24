/** Verifies the owned Chromium policy patch retains extension authorization and refuses upstream drift. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ELIZA_BROWSER_EXTENSION_ID,
  patchNativeMessagingAllowlist,
} from "../distro-android/prepare-chromium-browser.mjs";

const features =
  "BASE_FEATURE(kApiDesktopAndroidNativeMessagingBypassExtensionAllowlist, base::FEATURE_DISABLED_BY_DEFAULT);";
const source = `constexpr auto kAndroidNativeMessagingAllowedExtensionIds =
    base::MakeFixedFlatSet<std::string_view>({
        "existingextensionaaaaaaaaaaaaaaaa",
    });
if (!kAndroidNativeMessagingAllowedExtensionIds.contains(extension->id())) {
  opener_port->DispatchOnDisconnect(kUnauthorizedExtensionError);
  return;
}`;

test("adds one allowed identity and preserves rejection of other extensions", () => {
  const changed = patchNativeMessagingAllowlist(source, features);
  assert.ok(changed.includes(`"${ELIZA_BROWSER_EXTENSION_ID}"`));
  assert.ok(changed.includes('"existingextensionaaaaaaaaaaaaaaaa"'));
  assert.ok(
    changed.includes(
      "opener_port->DispatchOnDisconnect(kUnauthorizedExtensionError)",
    ),
  );
  assert.equal(patchNativeMessagingAllowlist(changed, features), changed);
});

test("refuses removed authorization and globally enabled bypass", () => {
  assert.throws(
    () =>
      patchNativeMessagingAllowlist(
        source.replace(
          "!kAndroidNativeMessagingAllowedExtensionIds.contains(extension->id())",
          "true",
        ),
        features,
      ),
    /authorization guard changed/,
  );
  assert.throws(
    () =>
      patchNativeMessagingAllowlist(
        source,
        features.replace(
          "FEATURE_DISABLED_BY_DEFAULT",
          "FEATURE_ENABLED_BY_DEFAULT",
        ),
      ),
    /disabled-by-default/,
  );
});

test("refuses ambiguous allowlists instead of patching unknown source", () => {
  assert.throws(
    () => patchNativeMessagingAllowlist(`${source}\n${source}`, features),
    /exactly one/,
  );
});
