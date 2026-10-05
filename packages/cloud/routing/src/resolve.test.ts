import { expect, test } from "bun:test";
import {
  getFeaturePolicy,
  type RouteSpec,
  RoutingPolicyError,
  resolveCloudRoute,
  resolveFeatureCloudRoute,
  toRuntimeSettings,
} from "./index.js";

const spec: RouteSpec = {
  service: "search",
  localKeySetting: "SEARCH_KEY",
  upstreamBaseUrl: "https://search.example/",
  localKeyAuth: { kind: "bearer" },
};
const runtime = (settings: Record<string, unknown>) =>
  toRuntimeSettings({ getSetting: (key) => settings[key] });
for (const policy of ["local", "cloud", "auto"] as const) {
  for (const local of [false, true])
    for (const cloud of [false, true]) {
      test(`${policy} policy with local=${local} cloud=${cloud}`, () => {
        const result = resolveFeatureCloudRoute(
          runtime({
            SEARCH_KEY: local ? "local" : undefined,
            ELIZAOS_CLOUD_API_KEY: "cloud",
            ELIZAOS_CLOUD_ENABLED: cloud,
          }),
          "tool_use",
          spec,
          policy,
        );
        const expected =
          policy === "local"
            ? local
              ? "local-key"
              : "disabled"
            : policy === "cloud"
              ? cloud
                ? "cloud-proxy"
                : "disabled"
              : local
                ? "local-key"
                : cloud
                  ? "cloud-proxy"
                  : "disabled";
        expect(result.source).toBe(expected);
        if (result.source !== "disabled")
          expect(result.headers.Authorization).toBe(
            `Bearer ${result.source === "local-key" ? "local" : "cloud"}`,
          );
      });
    }
}
for (const base of [
  "ftp://example.com",
  "https://user:secret@example.com",
  "https://example.com/?key=secret",
  "https://example.com/#fragment",
  "not a url",
]) {
  test(`invalid cloud base ${base}`, () => {
    expect(
      resolveCloudRoute(
        runtime({
          ELIZAOS_CLOUD_ENABLED: true,
          ELIZAOS_CLOUD_API_KEY: "key",
          ELIZAOS_CLOUD_BASE_URL: base,
        }),
        spec,
      ).source,
    ).toBe("disabled");
  });
}
test("invalid policy fails explicitly instead of silently falling back", () => {
  for (const policy of ["bogus", false, 3])
    expect(() =>
      getFeaturePolicy(
        runtime({ ELIZAOS_CLOUD_ROUTING_TOOL_USE: policy }),
        "tool_use",
      ),
    ).toThrow(RoutingPolicyError);
});
test("settings are reread and cloud service names cannot change URL authority or path", () => {
  const settings: Record<string, unknown> = {
    ELIZAOS_CLOUD_ENABLED: true,
    ELIZAOS_CLOUD_API_KEY: "key",
  };
  const source = runtime(settings);
  expect(resolveCloudRoute(source, spec).source).toBe("cloud-proxy");
  settings.ELIZAOS_CLOUD_ENABLED = false;
  expect(resolveCloudRoute(source, spec).source).toBe("disabled");
  settings.ELIZAOS_CLOUD_ENABLED = true;
  for (const service of ["../admin", "foo/bar", "https://other", "?query"])
    expect(resolveCloudRoute(source, { ...spec, service }).source).toBe(
      "disabled",
    );
});
