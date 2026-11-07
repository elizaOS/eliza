/**
 * Every locale the default prompt pack registers must reach the planner's
 * action catalog: OwnerFactStore.locale (or the first-message heuristic) ->
 * LocalizedExamplesProvider -> buildActionCatalog, on a real PGlite runtime.
 */

import type { ActionExample } from "@elizaos/core";
import { buildActionCatalog } from "@elizaos/plugin-assistant";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import { createOwnerLocaleExamplesProvider } from "../src/lifeops/i18n/localized-examples-provider.ts";
import {
  createMultilingualPromptRegistry,
  getDefaultPromptExamplePair,
  getDefaultPromptRegistry,
  PROMPT_REGISTRY_DEFAULT_LOCALE,
  registerDefaultPromptPack,
  registerMultilingualPromptRegistry,
} from "../src/lifeops/i18n/prompt-registry.ts";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
} from "../src/lifeops/owner/fact-store.ts";

const EXAMPLE_KEY = "OWNER_ROUTINES.example.0";

const ENGLISH_EXAMPLES: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "help me brush my teeth at 8 am and 9 pm every day" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: 'I can set up a habit named "Brush teeth" for 8 am and 9 pm daily. Confirm and I\'ll save it.',
        actions: ["OWNER_ROUTINES"],
      },
    },
  ],
];

const PACK_LOCALES = getDefaultPromptRegistry()
  .list({ exampleKey: EXAMPLE_KEY })
  .map((entry) => entry.locale)
  .filter((locale) => locale !== PROMPT_REGISTRY_DEFAULT_LOCALE);

let result: RealTestRuntimeResult | null = null;

beforeEach(async () => {
  result = await createRealTestRuntime();
});

afterEach(async () => {
  await result?.cleanup();
  result = null;
});

async function catalogUserText(
  ownerLocale: string | null,
  recentMessage: string | null,
): Promise<string | undefined> {
  const runtime = result?.runtime;
  if (!runtime) throw new Error("runtime not started");
  const store = createOwnerFactStore(runtime);
  registerOwnerFactStore(runtime, store);
  if (ownerLocale) {
    await store.update(
      { locale: ownerLocale },
      { source: "first_run", recordedAt: new Date().toISOString() },
    );
  }
  const registry = createMultilingualPromptRegistry();
  registerDefaultPromptPack(registry);
  registerMultilingualPromptRegistry(runtime, registry);

  const resolver = await createOwnerLocaleExamplesProvider(runtime)({
    recentMessage,
  });
  const catalog = buildActionCatalog(
    [
      {
        name: "OWNER_ROUTINES",
        description: "Manage owner routines and habits.",
        examples: ENGLISH_EXAMPLES,
      },
    ],
    { localizedExamples: resolver ?? undefined },
  );
  const examples = catalog.parentByName.get("OWNER_ROUTINES")?.examples as
    | ActionExample[][]
    | undefined;
  return examples?.[0]?.[0]?.content.text;
}

describe("owner-locale action examples for every registered pack", () => {
  it("covers more than the original four locales", () => {
    expect(PACK_LOCALES).toEqual(
      expect.arrayContaining(["ko", "pt", "tl", "vi", "zh-CN"]),
    );
  });

  it.each(PACK_LOCALES)(
    "owner locale %s gets its registered example",
    async (locale) => {
      const expected = getDefaultPromptExamplePair(EXAMPLE_KEY, locale)[0]
        .content.text;
      expect(await catalogUserText(locale, null)).toBe(expected);
    },
  );

  it("a Chinese first message (detected as zh-Hans) gets the zh-CN example", async () => {
    const expected = getDefaultPromptExamplePair(EXAMPLE_KEY, "zh-CN")[0]
      .content.text;
    expect(await catalogUserText(null, "每天早上8点提醒我刷牙")).toBe(expected);
  });
});
