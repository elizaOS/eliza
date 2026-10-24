// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { AdbFlasherBackend } from "./adb-backend";

const RELEASES_URL = "https://api.github.com/repos/elizaOS/eliza/releases";
const MANIFEST_NAME = "android-release-manifest-fixture.json";
const MANIFEST_URL = `https://github.com/elizaOS/eliza/releases/download/fixture/${MANIFEST_NAME}`;

function releases(
  assets: Array<{ name: string; browser_download_url: string }>,
) {
  return [{ tag_name: "v0.0.0", assets }];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("an unreadable release manifest fails discovery instead of reporting no builds", async () => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) === RELEASES_URL)
      return Response.json(
        releases([{ name: MANIFEST_NAME, browser_download_url: MANIFEST_URL }]),
      );
    return new Response("unavailable", { status: 503 });
  });

  await expect(new AdbFlasherBackend().listBuilds()).rejects.toThrow(
    `Android release manifest ${MANIFEST_NAME} returned HTTP 503.`,
  );
});

test("a release list without a manifest asset still reports that no manifest is published", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json(
      releases([
        {
          name: "boot.img",
          browser_download_url:
            "https://github.com/elizaOS/eliza/releases/download/fixture/boot.img",
        },
      ]),
    ),
  );

  await expect(new AdbFlasherBackend().listBuilds()).rejects.toThrow(
    "No published elizaOS Android release manifests are available.",
  );
});
