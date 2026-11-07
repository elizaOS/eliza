import { describe, expect, spyOn, test } from "bun:test";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import {
  finalizeSharedRealtimeReply,
  hasSharedRealtimeIntent,
  requireTraceableRealtimeSearch,
  resolveSharedPublicSearchIntent,
  resolveSharedRealtimeRequirement,
  type SharedRealtimeBindingDiagnostic,
} from "./shared-realtime-grounding";

const observedAt = Date.UTC(2026, 7, 22, 7, 0, 0);
const grounding: SharedRuntimePublicGrounding = {
  kind: "web_search",
  query: "what is btc price rn",
  provider: "parallel",
  observedAt,
  sourceUrls: ["https://coin.example/bitcoin"],
  sources: [
    {
      url: "https://coin.example/bitcoin",
      text: JSON.stringify({
        url: "https://coin.example/bitcoin",
        title: "Bitcoin price",
        excerpt: "Bitcoin is 77,357.93 USD at 07:00 UTC.",
      }),
    },
  ],
  text: JSON.stringify({
    results: [
      {
        url: "https://coin.example/bitcoin",
        title: "Bitcoin price",
        excerpt: "Bitcoin is 77,357.93 USD at 07:00 UTC.",
      },
    ],
  }),
  truncated: false,
};

describe("Shared realtime binding refusal diagnostics", () => {
  test("missing markers expose only bounded diagnostic fields, never the draft", () => {
    const diagnostics: SharedRealtimeBindingDiagnostic[] = [];
    const draft = "PRIVATE_DRAFT_SENTINEL 12345";
    const reply = finalizeSharedRealtimeReply(draft, grounding, (value) => diagnostics.push(value));
    expect(reply).toContain("couldn’t verify");
    expect(reply).not.toContain("parallel");
    expect(reply).not.toContain(new Date(observedAt).toISOString());
    expect(diagnostics).toEqual([
      {
        reason: "marker_missing",
        markerCount: 0,
        knownSourceMarkerCount: 0,
        failedPredicateMask: 0,
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(draft);
    expect(JSON.stringify(diagnostics)).not.toContain(grounding.sources?.[0].text ?? "");
  });

  test("a marker outside the receipt has a source reason without logging its URL", () => {
    const diagnostics: SharedRealtimeBindingDiagnostic[] = [];
    const otherUrl = "https://different.example/private-draft-sentinel";
    finalizeSharedRealtimeReply(
      `Bitcoin is 77,357.93 USD. [[SOURCE_URL:${otherUrl}]]`,
      grounding,
      (value) => diagnostics.push(value),
    );
    expect(diagnostics[0]).toEqual({
      reason: "source_not_in_receipt",
      markerCount: 1,
      knownSourceMarkerCount: 0,
      failedPredicateMask: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain(otherUrl);
  });

  test("unit mismatch records the predicate while preserving the refusal", () => {
    const diagnostics: SharedRealtimeBindingDiagnostic[] = [];
    const draft = "Bitcoin is 77,357.93 EUR. [[SOURCE_URL:https://coin.example/bitcoin]]";
    const reply = finalizeSharedRealtimeReply(draft, grounding, (value) => diagnostics.push(value));
    expect(reply).toBe(finalizeSharedRealtimeReply(draft, grounding));
    expect(diagnostics[0]?.reason).toBe("claim_not_supported");
    expect((diagnostics[0]?.failedPredicateMask ?? 0) & 4).toBe(4);
  });

  test("an observer failure cannot change the refusal or escape the boundary", () => {
    const draft = "A draft without a source marker";
    const expected = finalizeSharedRealtimeReply(draft, grounding);
    let observations = 0;
    expect(
      finalizeSharedRealtimeReply(draft, grounding, () => {
        observations += 1;
        throw new Error("PRIVATE_OBSERVER_ERROR_SENTINEL");
      }),
    ).toBe(expected);
    expect(observations).toBe(1);
  });
});

describe("search authority after a conversation topic changes", () => {
  const history = [
    {
      role: "user" as const,
      content: "What is the current bitcoin price? Reply briefly.",
    },
    {
      role: "assistant" as const,
      content: "A public price result.",
      grounding: {
        ...grounding,
        query: "current public bitcoin price",
        observedAt: Date.now(),
      },
    },
  ];

  test("ordinary questions do not search or replace the answer with a source refusal", () => {
    for (const message of [
      "What is 17 plus 26? Reply briefly.",
      "Wait so I just wait that’s it? And you handle the rest? Do you have all data you need from me? And also how does the network and all this and you work I’m curious",
      "Why do you always reply? Should you react with an emoji instead?",
      "Why do you keep trying to web search and when you do it breaks?",
      "How does it work?",
      "Thanks, that helps!",
    ]) {
      expect(hasSharedRealtimeIntent(message, history)).toBe(false);
      expect(resolveSharedRealtimeRequirement(message, history)).toBeUndefined();
      expect(resolveSharedPublicSearchIntent(message, history)).toBeUndefined();
    }
  });

  test("an explicit evidence follow-up and a fresh public question still search", () => {
    for (const message of ["Check that price again", "Is that correct?", "Show me the sources"]) {
      expect(hasSharedRealtimeIntent(message, history)).toBe(true);
      expect(resolveSharedRealtimeRequirement(message, history)?.domain).toBe("markets");
    }
    expect(
      resolveSharedPublicSearchIntent("What is the current bitcoin price?", history)?.kind,
    ).toBe("prefetched");
  });
});

describe("recovered general-public citation and messaging presentation", () => {
  const url = "https://docs.example.com/limits";
  const sourceText =
    "The project quota is 1,200,000 units per minute; the user quota is 6,000 units per minute.";
  const receipt: SharedRuntimePublicGrounding = {
    kind: "web_search",
    provider: "parallel",
    query: "public API documentation limits",
    observedAt,
    truncated: false,
    text: sourceText,
    sourceUrls: [url],
    sources: [{ url, text: sourceText }],
  };
  const general = (claim: string, evidence = receipt, selected = url) =>
    finalizeSharedRealtimeReply(
      `${claim} [[SOURCE_URL:${selected}]]`,
      evidence,
      undefined,
      "general_public",
    );

  test("general citations allow numeric-preserving paraphrases without changing strict realtime validation", () => {
    const paraphrase =
      "Each user can use 6,000 units per minute; each project can use 1,200,000 units per minute.";
    expect(general(paraphrase)).toContain(paraphrase);
    expect(general(paraphrase)).toContain(`Source: ${url}`);
    expect(
      finalizeSharedRealtimeReply(`${paraphrase} [[SOURCE_URL:${url}]]`, receipt),
    ).not.toContain(paraphrase);
    const natural = "The project quota is 1,200,000 units per minute";
    for (const mode of ["realtime", "general_public"] as const) {
      const reply = finalizeSharedRealtimeReply(
        `${natural} [source](${url}).`,
        receipt,
        undefined,
        mode,
      );
      expect(reply).toContain(natural);
      expect(reply).toContain(`Source: ${url}`);
    }
  });

  test("clear magnitudes work in claims and evidence, while ambiguity and invented numbers stay rejected", () => {
    for (const claim of [
      "The project quota is 1.2 million units per minute.",
      "The project quota is 1.2M units per minute; the user quota is 6k units per minute.",
      "The user quota is 6 thousand units per minute.",
    ])
      expect(general(claim)).toContain(claim);
    const abbreviated = {
      ...receipt,
      sources: [{ url, text: "The quota is 1.2M units; the allowance is 6k units." }],
    };
    expect(general("The quota is 1,200,000 units.", abbreviated)).toContain("1,200,000 units");
    const decimal = { ...receipt, sources: [{ url, text: "The limit is 1,005 units." }] };
    expect(general("The limit is 1.005k units.", decimal)).toContain("1.005k units");
    for (const claim of [
      "The quota is 9 million units.",
      "The quota is 1,20 million units.",
      "The quota is 1.2.3M units.",
      "The quota is 999999999999999B units.",
      "The allowance is 6m units.",
      "The allowance is 6MB.",
      "The allowance is 6m/s.",
    ])
      expect(general(claim)).not.toContain(claim);
    const strictDraft = `The quota is 1.2M units. [[SOURCE_URL:${url}]]`;
    expect(finalizeSharedRealtimeReply(strictDraft, receipt)).not.toContain("1.2M units");
  });

  test("malformed magnitude evidence cannot lend digits or poison a separate supported quantity", () => {
    const mixed = {
      ...receipt,
      sources: [{ url, text: "Raised 1,5 million euros; revenue 3 billion." }],
    };
    expect(general("Revenue is 3 billion.", mixed)).toContain("Revenue is 3 billion.");
    for (const claim of ["Raised 15.", "Raised 1.5 million euros.", "Raised 1,5 million euros."]) {
      expect(general(claim, mixed)).not.toContain(claim);
    }
    const currency = { ...receipt, sources: [{ url, text: "The amount is 1,200,000 USD." }] };
    expect(general("The amount is 1.2M USD.", currency)).toContain("1.2M USD");
    expect(general("The amount is 1.2M EUR.", currency)).not.toContain("1.2M EUR");
  });

  test("realtime numeric refusal remains closed and exposes only the existing diagnostic mask", () => {
    const weather = {
      ...receipt,
      query: "current public weather in Example City",
      sources: [{ url, text: "The temperature is 18.3 degrees Celsius." }],
    };
    const diagnostics: SharedRealtimeBindingDiagnostic[] = [];
    const reply = finalizeSharedRealtimeReply(
      `The temperature is 19 degrees Celsius. [[SOURCE_URL:${url}]]`,
      weather,
      (value) => diagnostics.push(value),
    );
    expect(reply).not.toContain("19 degrees");
    expect(diagnostics[0]?.reason).toBe("claim_not_supported");
    expect((diagnostics[0]?.failedPredicateMask ?? 0) & 2).toBe(2);
    expect(JSON.stringify(diagnostics)).not.toContain("18.3");
  });

  test("partial answers retain supported claims and honest context without raw tool narration", () => {
    for (const mode of ["realtime", "general_public"] as const) {
      const text = "The limit is 1,200 units. The allowance is 6,000 units.";
      const limits = { ...receipt, text, sources: [{ url, text }] };
      const complete = finalizeSharedRealtimeReply(
        `The limit is 1,200 units [[SOURCE_URL:${url}]].`,
        limits,
        undefined,
        mode,
      );
      expect(complete).toStartWith("The limit is 1,200 units.\n\nSource:");
      expect(complete).not.toContain("I found part");
      const partial = finalizeSharedRealtimeReply(
        `The limit is 1,200 units. [[SOURCE_URL:${url}]] The allowance is 9,000 units. [[SOURCE_URL:${url}]]`,
        limits,
        undefined,
        mode,
      );
      expect(partial).toStartWith("I found part of the answer:\n\nThe limit is 1,200 units.");
      expect(partial).not.toContain("9,000");
      for (const internal of ["parallel", "checked", "draft", new Date(observedAt).toISOString()])
        expect(partial).not.toContain(internal);
    }
  });

  test("canonical display never substitutes a source without independently validating the same claim", () => {
    const canonical = "https://developers.google.com/workspace/gmail/api/reference/quota";
    const localized = `${canonical}?hl=en`;
    const different = `${canonical}?version=2`;
    const mirror = "https://developers.google.cn/workspace/gmail/api/reference/quota?hl=en";
    const common = "The limit is 1,200 units.";
    const distinct = "The allowance is 6,000 units.";
    const evidence = {
      ...receipt,
      sourceUrls: [canonical, localized, different, mirror],
      sources: [
        { url: canonical, text: common },
        { url: localized, text: common },
        { url: different, text: common },
        { url: mirror, text: `${common} ${distinct}` },
      ],
    };
    const before = JSON.stringify(evidence);
    for (const mode of ["realtime", "general_public"] as const) {
      const duplicate = finalizeSharedRealtimeReply(
        `${common} [[SOURCE_URL:${canonical}]] ${common} [[SOURCE_URL:${localized}]] ${common} [[SOURCE_URL:${mirror}]]`,
        evidence,
        undefined,
        mode,
      );
      expect(duplicate).toContain(`Source: ${canonical}`);
      expect(duplicate).not.toContain(mirror);
      expect(duplicate).not.toContain(localized);
      const retained = finalizeSharedRealtimeReply(
        `${common} [[SOURCE_URL:${different}]] ${distinct} [[SOURCE_URL:${mirror}]]`,
        evidence,
        undefined,
        mode,
      );
      expect(retained).toContain(different);
      expect(retained).toContain(mirror);
      const forged = finalizeSharedRealtimeReply(
        `${common} [[SOURCE_URL:https://unknown.example/limits]]`,
        evidence,
        undefined,
        mode,
      );
      expect(forged).not.toContain(common);
      expect(forged).not.toContain("unknown.example");
    }
    expect(JSON.stringify(evidence)).toBe(before);
  });
});

test("source refusal audit preserves only validated closed provider diagnostics", () => {
  const sink = spyOn(console, "info").mockImplementation(() => {});
  const sourceDiagnostics = [
    { hop: "observation", outcome: "http-error", httpStatus: 503, elapsedMs: 1450 },
  ];
  const query = "current public weather in San Francisco, California";
  try {
    const unavailable = requireTraceableRealtimeSearch(
      {
        success: false,
        error: "PRIVATE_PROVIDER_SENTINEL",
        data: {
          unavailableReason: "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
          sourceDiagnostics,
          private: "PRIVATE_PROVIDER_SENTINEL",
        },
      },
      query,
    );
    expect(unavailable.success).toBe(false);
    const diagnostic = sink.mock.calls.find(
      (call) => call[0] === "[shared-realtime] source receipt refused",
    )?.[1];
    expect(diagnostic).toMatchObject({
      unavailableReason: "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
      sourceDiagnostics,
      queryScopeRejected: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_PROVIDER_SENTINEL");
    expect(JSON.stringify(diagnostic)).not.toContain(query);
    sink.mockClear();
    requireTraceableRealtimeSearch(
      {
        success: false,
        error: "PUBLIC_SEARCH_QUERY_SCOPE_MISMATCH",
        data: {
          unavailableReason: "PRIVATE_UNKNOWN_REASON",
          sourceDiagnostics: [{ ...sourceDiagnostics[0], url: "https://private.example" }],
        },
      },
      query,
    );
    const scoped = sink.mock.calls.find(
      (call) => call[0] === "[shared-realtime] source receipt refused",
    )?.[1];
    expect(scoped).toMatchObject({ queryScopeRejected: true });
    expect(scoped).not.toHaveProperty("unavailableReason");
    expect(scoped).not.toHaveProperty("sourceDiagnostics");
    expect(JSON.stringify(scoped)).not.toContain("PRIVATE_UNKNOWN_REASON");
    expect(JSON.stringify(scoped)).not.toContain("https://");
  } finally {
    sink.mockRestore();
  }
});
