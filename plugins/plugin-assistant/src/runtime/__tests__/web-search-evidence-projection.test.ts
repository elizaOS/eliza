import type { PlannerStep, PlannerToolResult } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  projectToolResultForModel,
  toolMessageContent,
  trajectoryStepsToMessages,
} from "../planner-rendering";

function result(): PlannerToolResult {
  const record = {
    url: "https://example.com/news",
    title: "Current report",
    excerpts: ["Complete first paragraph", "Complete second paragraph"],
    publish_date: "2026-10-13",
    score: 0.95,
    custom: { retained: true },
  };
  const text = JSON.stringify({
    search_id: "public-search",
    results: [record],
    extra: { complete: true },
  });
  return {
    success: true,
    text,
    data: {
      actionName: "WEB_SEARCH",
      provider: "parallel",
      query: "public news",
      observedAt: 1791849600000,
      truncated: false,
      value: text,
      sourceUrls: [record.url],
      sources: [
        {
          url: record.url,
          text: JSON.stringify(record),
          publication: { precision: "calendar-day", day: "2026-10-13" },
        },
      ],
    },
  };
}

function sourcesOf(value: PlannerToolResult): Array<{ text: string }> {
  const sources = value.data?.sources;
  if (!Array.isArray(sources)) throw new Error("Missing fixture sources");
  return sources as Array<{ text: string }>;
}

describe("WEB_SEARCH exact model evidence projection", () => {
  it("real serializer keeps complete evidence once without mutating action or metadata", () => {
    const original = result();
    const before = structuredClone(original);
    const projected = JSON.parse(toolMessageContent(original));
    expect(projected.text).toBe(original.text);
    expect(projected.data.value).toBe("[Same evidence as result.text]");
    expect(projected.data.sources[0].text).toBe(
      "[Same evidence as result.text JSON /results/0]",
    );
    expect(projected.data.sources[0].publication).toEqual({
      precision: "calendar-day",
      day: "2026-10-13",
    });
    expect(projected.data.sourceUrls).toEqual(original.data?.sourceUrls);
    expect(original).toEqual(before);
    const parsed = JSON.parse(projected.text);
    expect(parsed.results[0].custom).toEqual({ retained: true });
    expect(parsed.extra).toEqual({ complete: true });
    expect(toolMessageContent(original).length).toBeLessThan(
      JSON.stringify(original, null, 2).length,
    );
  });
  it("native trajectory tool messages use the same guarded projection", () => {
    const original = result();
    const messages = trajectoryStepsToMessages([
      {
        iteration: 1,
        toolCall: {
          id: "tool-1",
          name: "WEB_SEARCH",
          params: { query: "public news" },
        },
        result: original,
      } as PlannerStep,
    ]);
    const content = messages[1].content as Array<{ output: { value: string } }>;
    expect(JSON.parse(content[0].output.value)).toEqual(
      projectToolResultForModel(original),
    );
    expect(original.data?.value).toBe(original.text);
  });
  it("different value and unique source evidence remain complete", () => {
    const original = result();
    const data = original.data;
    if (!data) throw new Error("Missing fixture data");
    data.value = "Additional unique provider explanation";
    const sources = data.sources as Array<{ url: string; text: string }>;
    sources[0].text = JSON.stringify({
      ...JSON.parse(sources[0].text),
      score: 0.96,
    });
    expect(projectToolResultForModel(original)).toEqual(original);
  });
  it("JSON key order may differ but every nested field must match", () => {
    const original = result();
    const sources = original.data?.sources as Array<{ text: string }>;
    const record = JSON.parse(sources[0].text);
    sources[0].text = JSON.stringify(
      Object.fromEntries(Object.entries(record).reverse()),
    );
    expect(sourcesOf(projectToolResultForModel(original))[0].text).toContain(
      "/results/0",
    );
    record.custom.extra = "unique";
    sources[0].text = JSON.stringify(record);
    expect(sourcesOf(projectToolResultForModel(original))[0].text).toBe(
      sources[0].text,
    );
  });
  it("malformed, ambiguous and hostile source JSON never acquires a reference", () => {
    for (const sourceText of [
      "not JSON",
      '{"__proto__":{"polluted":true}}',
      '{"url":"https://different.example","excerpts":[]}',
    ]) {
      const original = result();
      const sources = original.data?.sources as Array<{ text: string }>;
      sources[0].text = sourceText;
      expect(sourcesOf(projectToolResultForModel(original))[0].text).toBe(
        sourceText,
      );
    }
    const original = result();
    const payload = JSON.parse(original.text ?? "");
    payload.results.push(payload.results[0]);
    original.text = JSON.stringify(payload);
    expect(sourcesOf(projectToolResultForModel(original))[0].text).toBe(
      sourcesOf(original)[0].text,
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it("other actions, failed, non-JSON and over-budget payloads keep original shape", () => {
    for (const original of [
      { ...result(), success: false },
      { ...result(), text: "not JSON" },
      { ...result(), text: "x".repeat(262145) },
      { ...result(), data: { ...result().data, actionName: "WEB_FETCH" } },
      { ...result(), data: { ...result().data, provider: "unknown" } },
    ])
      expect(projectToolResultForModel(original)).toEqual(original);
  });
});

it("preserves public retry metadata and explicit producer replace-data contract", () => {
  const original = {
    ...result(),
    registeredSubaction: "runtime-only",
    promptDataMode: "replace-data" as const,
    promptData: { producer: "complete" },
  };
  const projected = projectToolResultForModel(original);
  expect(projected.data).toEqual({ producer: "complete" });
  expect(projected.registeredSubaction).toBeUndefined();
  expect(original.registeredSubaction).toBe("runtime-only");
  expect(original.data?.sources).toHaveLength(1);
});
