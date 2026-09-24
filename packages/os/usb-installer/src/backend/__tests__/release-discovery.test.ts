// Exercises checksum-backed ISO discovery from authoritative OS releases.
import { describe, expect, it, vi } from "vitest";
import { fetchPublishedIsoImages } from "../release-discovery";

const isoName = "elizaos-live-beta-2026.08.17-amd64.iso";
const checksum = "0123456789abcdef".repeat(4);
const assetRoot = "https://github.com/elizaOS/os/releases/download/v1";

function fetchMock(checksumBody = `${checksum}  ${isoName}\n`): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/releases")) {
      return Response.json([
        {
          tag_name: "v1-beta",
          published_at: "2026-08-17T00:00:00Z",
          prerelease: true,
          assets: [
            {
              name: isoName,
              browser_download_url: `${assetRoot}/${isoName}`,
              size: 2_000_000_000,
            },
            {
              name: `${isoName}.sha256`,
              browser_download_url: `${assetRoot}/${isoName}.sha256`,
              size: 96,
            },
          ],
        },
      ]);
    }
    return new Response(checksumBody);
  }) as unknown as typeof fetch;
}

describe("OS ISO release discovery", () => {
  it("returns an ISO only after resolving its exact checksum asset", async () => {
    const images = await fetchPublishedIsoImages(fetchMock());
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      architecture: "x86_64",
      channel: "beta",
      checksumSha256: checksum,
      sizeBytes: 2_000_000_000,
    });
  });

  it("does not advertise an ISO without a checksum sidecar", async () => {
    const mock = fetchMock();
    const response = await mock(
      new Request("https://api.github.com/repos/elizaOS/os/releases"),
    );
    const releases = (await response.json()) as Array<{ assets: unknown[] }>;
    releases[0]?.assets.pop();
    const noChecksumFetch = vi.fn(async () => Response.json(releases));
    expect(
      await fetchPublishedIsoImages(noChecksumFetch as unknown as typeof fetch),
    ).toEqual([]);
  });

  it("rejects a checksum sidecar naming a different artifact", async () => {
    await expect(
      fetchPublishedIsoImages(fetchMock(`${checksum}  other.iso\n`)),
    ).rejects.toThrow(/Checksum contract is invalid/);
  });
});
