import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const FEED_CLIENT_PATH = join(ROOT, "apps/web/src/app/feed/FeedClient.tsx");
const ROOT_LAYOUT_PATH = join(ROOT, "apps/web/src/app/layout.tsx");
const COMPONENTS_INDEX_PATH = join(
  ROOT,
  "apps/web/src/app/feed/components/index.ts",
);

describe("feed component wiring", () => {
  it("defaults /feed to the For You tab", () => {
    const source = readFileSync(FEED_CLIENT_PATH, "utf8");

    expect(source).toMatch(
      /const \[tab,\s*setTab\] = useState<FeedTab>\(["']forYou["']\)/,
    );
  });

  it("renders Stories through ForYouFeedList instead of the retired NarrativeStoryList", () => {
    const source = readFileSync(FEED_CLIENT_PATH, "utf8");
    const storiesBranchMatch = source.match(
      /if \(tab === ["']stories["']\) \{([\s\S]*?)\n\s*\}\n\n\s*if \(tab === ["']forYou["']\) \{/m,
    );

    expect(storiesBranchMatch).toBeTruthy();
    const storiesBranch = storiesBranchMatch?.[1] ?? "";

    expect(storiesBranch).toContain("<ForYouFeedList");
    expect(storiesBranch).toContain('surface="stories"');
    expect(storiesBranch).not.toContain("NarrativeStoryList");
  });

  it("does not re-export NarrativeStoryList from the feed components barrel", () => {
    const source = readFileSync(COMPONENTS_INDEX_PATH, "utf8");

    expect(source).not.toContain("NarrativeStoryList");
  });

  it("keeps Vercel observability opt-in from the root layout", () => {
    const source = readFileSync(ROOT_LAYOUT_PATH, "utf8");

    expect(source).toContain(
      'process.env.NEXT_PUBLIC_ENABLE_VERCEL_OBSERVABILITY === "1"',
    );
    expect(source).toMatch(
      /ENABLE_VERCEL_OBSERVABILITY \? \(\s*<>\s*<Analytics \/>\s*<GatedSpeedInsights disabled=\{isMinimalLayout\} \/>\s*<\/>/,
    );
  });
});
