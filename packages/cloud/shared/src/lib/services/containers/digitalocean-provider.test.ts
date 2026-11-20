/**
 * Pagination contract of the DigitalOcean compute adapter: DO serves droplets
 * and volumes page by page, so the adapter must follow `links.pages.next`
 * instead of returning page one as the whole inventory.
 */
import { describe, expect, test } from "bun:test";
import { DigitalOceanComputeError, DigitalOceanComputeProvider } from "./digitalocean-provider";

const DROPLET_TAGS = ["eliza-cloud", "production", "data-plane"];

function droplet(id: number) {
  return {
    id,
    name: `droplet-${id}`,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    tags: DROPLET_TAGS,
    networks: { v4: [{ ip_address: `10.0.0.${(id % 250) + 1}`, type: "private" }] },
  };
}

function volume(id: string) {
  return {
    id,
    name: `volume-${id}`,
    size_gigabytes: 10,
    region: { slug: "nyc3", name: "New York 3" },
    droplet_ids: [],
    tags: DROPLET_TAGS,
  };
}

function pages<T>(url: URL, collection: string, pageOne: T[], pageTwo: T[], page: number) {
  const next = page === 1 ? `https://api.digitalocean.com/v2/${collection}?page=2` : null;
  return Response.json({
    [collection]: page === 1 ? pageOne : pageTwo,
    links: { pages: { first: null, prev: null, next } },
    meta: { total: pageOne.length + pageTwo.length },
  });
}

function provider(
  handler: (url: URL) => Response,
  requests: string[] = [],
): DigitalOceanComputeProvider {
  return DigitalOceanComputeProvider.withToken("test-token", {
    apiBase: "https://api.digitalocean.com/v2",
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(`${url.pathname}?${url.searchParams.toString()}`);
      return handler(url);
    }) as typeof globalThis.fetch,
  });
}

describe("DigitalOcean list pagination", () => {
  test("listServers returns droplets from every linked page", async () => {
    const requests: string[] = [];
    const first = Array.from({ length: 200 }, (_, i) => droplet(i + 1));
    const second = Array.from({ length: 50 }, (_, i) => droplet(201 + i));
    const client = provider((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return pages(url, "droplets", first, second, page);
    }, requests);

    const servers = await client.listServers({ "managed-by": "eliza-cloud" });

    expect(servers).toHaveLength(250);
    expect(servers.at(-1)?.id).toBe(250);
    expect(requests).toEqual([
      "/v2/droplets?per_page=200&tag_name=eliza-cloud&page=1",
      "/v2/droplets?per_page=200&tag_name=eliza-cloud&page=2",
    ]);
  });

  test("listVolumes returns volumes from every linked page", async () => {
    const first = Array.from({ length: 200 }, (_, i) => volume(`vol-${i + 1}`));
    const second = [volume("vol-201")];
    const client = provider((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return pages(url, "volumes", first, second, page);
    });

    const volumes = await client.listVolumes({ location: "nyc3" });

    expect(volumes).toHaveLength(201);
    expect(volumes.at(-1)?.id).toBe("vol-201");
  });

  test("a repeated resource id across pages is a typed error", async () => {
    const first = Array.from({ length: 200 }, (_, i) => droplet(i + 1));
    const client = provider((url) => {
      const page = Number(url.searchParams.get("page") ?? "1");
      return pages(url, "droplets", first, [droplet(200)], page);
    });

    const error = await client.listServers().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DigitalOceanComputeError);
    expect((error as DigitalOceanComputeError).message).toContain(
      "pagination repeated droplets id 200",
    );
  });

  test("a list response without pagination metadata is a typed error", async () => {
    const client = provider(() => Response.json({ droplets: [droplet(1)] }));

    const error = await client.listServers().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DigitalOceanComputeError);
    expect((error as DigitalOceanComputeError).message).toContain("missing pagination metadata");
  });
});
