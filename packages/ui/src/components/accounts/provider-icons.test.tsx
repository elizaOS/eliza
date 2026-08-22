/** Verifies external API accounts never render with the Eliza Cloud identity. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiKeyMark, ElizaCloudMark, ProviderMark } from "./provider-icons";

describe("linked-account provider marks", () => {
  it.each(["openrouter-api", "xai-api"] as const)(
    "uses the neutral API-key glyph for %s",
    (providerId) => {
      const renderedProvider = renderToStaticMarkup(
        <ProviderMark providerId={providerId} title={providerId} />,
      );
      const renderedNeutral = renderToStaticMarkup(
        <ApiKeyMark title={providerId} />,
      );
      const renderedCloud = renderToStaticMarkup(
        <ElizaCloudMark title={providerId} />,
      );

      expect(renderedProvider).toBe(renderedNeutral);
      expect(renderedProvider).not.toBe(renderedCloud);
    },
  );
});
