/** Verifies live-trajectory accounting and complete wire records through deterministic usage fixtures and a real local HTTP server. */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  addUsage,
  buildLiveControllerPrompt,
  liveUsageCostUsd,
  openAiResponse,
  resolveLiveTrajectoryConfig,
  runController,
  selectLiveTrajectoryObjects,
  usageOf,
} from "../produce-content-context-live-trajectories.mjs";

const SHA = "a".repeat(40);
const FAMILIES = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
];

const PRICING = {
  "input-usd-per-million": "1",
  "cached-input-usd-per-million": "0.1",
  "cache-write-input-usd-per-million": "1.25",
  "output-usd-per-million": "2",
  "judge-input-usd-per-million": "5",
  "judge-cached-input-usd-per-million": "0.5",
  "judge-cache-write-input-usd-per-million": "6.25",
  "judge-output-usd-per-million": "10",
};

function responseUsage(
  input: number,
  output: number,
  cached: number,
  written: number,
) {
  return {
    usage: {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      input_tokens_details: {
        cached_tokens: cached,
        cache_write_tokens: written,
      },
    },
  };
}

function object(family: string, byteLength: number) {
  return {
    id: `${family}-${byteLength}`,
    family,
    format: "single-line",
    byteLength,
    canaries: [
      {
        label: "end",
        text: `SECRET:${family}`,
        byteStart: byteLength - 20,
        byteEnd: byteLength,
      },
    ],
  };
}

describe("live progressive-content trajectory producer", () => {
  it("resends instructions on continuations and records complete ordered tool pages", async () => {
    const canary = "END:🧪:complete";
    const source = `${"synthetic source\n".repeat(5000)}${canary}`;
    const bytes = Buffer.from(source);
    const object = {
      family: "file",
      revision: "revision-one",
      canaries: [
        {
          label: "end",
          text: canary,
          byteStart: bytes.length - Buffer.byteLength(canary),
        },
      ],
    };
    const requests: string[] = [];
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        requests.push(Buffer.concat(chunks).toString("utf8"));
        const turn = requests.length;
        const output =
          turn <= 2
            ? [
                {
                  type: "function_call",
                  name: "read_content",
                  call_id: `call_${turn}`,
                  arguments: JSON.stringify({ offset: turn === 1 ? 0 : 65536 }),
                },
              ]
            : [
                {
                  type: "message",
                  content: [{ type: "output_text", text: canary }],
                },
              ];
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(
          JSON.stringify({
            id: `response_${turn}`,
            model: "controller",
            status: "completed",
            service_tier: "default",
            ...responseUsage(100, 10, 0, 0),
            output,
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP fixture port");
    try {
      const config = resolveLiveTrajectoryConfig(
        {
          ...PRICING,
          "corpus-root": ".",
          output: "out",
          commit: SHA,
          model: "controller",
          "judge-model": "judge",
        },
        { OPENAI_API_KEY: "test-only" },
      );
      const target = {
        object,
        read: async ({
          offset,
          limit,
          access,
          expectedRevision,
        }: {
          offset: number;
          limit: number;
          access: string;
          expectedRevision: string;
        }) => {
          if (access !== "authorized" || expectedRevision !== object.revision)
            throw new Error("Read lost its authorization or revision");
          const end = Math.min(bytes.length, offset + limit);
          return {
            bytes: bytes.subarray(offset, end),
            view: {
              slice: {
                range: { start: offset, end },
                nextOffset: end < bytes.length ? end : null,
                hasMore: end < bytes.length,
                sliceSha256: createHash("sha256")
                  .update(bytes.subarray(offset, end))
                  .digest("hex"),
              },
            },
          };
        },
      };
      const result = await runController(
        config,
        target,
        object,
        (_endpoint: string, init: RequestInit) =>
          fetch(`http://127.0.0.1:${address.port}`, init),
      );
      const transmitted = requests.map((request) => JSON.parse(request));
      expect(transmitted[0].instructions).toBeTruthy();
      expect(
        transmitted
          .slice(1)
          .every(
            (request) => request.instructions === transmitted[0].instructions,
          ),
      ).toBe(true);
      expect(
        transmitted
          .slice(1)
          .map((request) => JSON.parse(request.input[0].output).text)
          .join(""),
      ).toBe(source);
      expect(result.finalAnswer).toBe(canary);
      expect(result.modelCalls.map((call) => call.request)).toEqual(
        transmitted,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("retains the complete transmitted request and response without credentials", async () => {
    const content = "Full Unicode source 🧪\n".repeat(6000);
    const request = { model: "controller", input: content };
    const payload = {
      id: "resp_local_http",
      model: "controller",
      status: "completed",
      service_tier: "default",
      ...responseUsage(100, 20, 10, 5),
      output: [
        { type: "message", content: [{ type: "output_text", text: content }] },
      ],
    };
    let received = "";
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        received = Buffer.concat(chunks).toString("utf8");
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify(payload));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No HTTP fixture port");
    const url = `http://127.0.0.1:${address.port}`;
    try {
      const exchange = await openAiResponse(
        { apiKey: "test-private-api-key" },
        request,
        (_endpoint: string, init: RequestInit) => {
          const pending = fetch(url, init);
          request.input = "caller changed after dispatch";
          return pending;
        },
      );
      expect(exchange.request).toEqual(JSON.parse(received));
      expect(exchange.request.input).toBe(content);
      expect(exchange.response.output[0].content[0].text).toBe(content);
      expect(JSON.stringify(exchange)).not.toContain("test-private-api-key");
      payload.service_tier = "priority";
      await expect(
        openAiResponse(
          { apiKey: "test-only" },
          request,
          (_endpoint: string, init: RequestInit) => fetch(url, init),
        ),
      ).rejects.toThrow("unpriced service tier");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails closed when direct OpenAI credentials are absent", () => {
    expect(() =>
      resolveLiveTrajectoryConfig(
        {
          "corpus-root": ".",
          output: "out",
          commit: SHA,
          model: "gpt-live",
          "judge-model": "gpt-judge",
          "input-usd-per-million": "1",
          "output-usd-per-million": "2",
        },
        {},
      ),
    ).toThrow("OPENAI_API_KEY is required");
  });

  it("requires an independent judge model and explicit positive pricing", () => {
    const base = {
      ...PRICING,
      "corpus-root": ".",
      output: "out",
      commit: SHA,
      model: "gpt-controller",
      "judge-model": "gpt-controller",
      "input-usd-per-million": "1",
      "output-usd-per-million": "2",
    };
    expect(() =>
      resolveLiveTrajectoryConfig(base, { OPENAI_API_KEY: "secret" }),
    ).toThrow("must be distinct");
    expect(() =>
      resolveLiveTrajectoryConfig(
        {
          ...base,
          "judge-model": "gpt-judge",
          "input-usd-per-million": "0",
        },
        { OPENAI_API_KEY: "secret" },
      ),
    ).toThrow("must be a positive number");
  });

  it("prices each model's actual cached, written, ordinary input and output separately", () => {
    const config = resolveLiveTrajectoryConfig(
      {
        ...PRICING,
        "corpus-root": ".",
        output: "out",
        commit: SHA,
        model: "controller",
        "judge-model": "judge",
      },
      { OPENAI_API_KEY: "test-only" },
    );
    const controller = addUsage(
      usageOf(responseUsage(100, 10, 40, 20)),
      usageOf(responseUsage(200, 20, 100, 50)),
    );
    const judge = usageOf(responseUsage(80, 8, 20, 10));
    // Controller: $0.0002515; judge: $0.0004025. Pooling the models would undercharge.
    expect(liveUsageCostUsd(config, controller, judge)).toBeCloseTo(
      0.000654,
      12,
    );
    const incompletePricing = {
      ...PRICING,
      "judge-output-usd-per-million": undefined,
    };
    expect(() =>
      resolveLiveTrajectoryConfig(
        {
          ...incompletePricing,
          "corpus-root": ".",
          output: "out",
          commit: SHA,
          model: "controller",
          "judge-model": "judge",
        },
        { OPENAI_API_KEY: "test-only" },
      ),
    ).toThrow("judge output USD rate");
  });

  it("rejects absent, malformed, and inconsistent provider usage instead of reporting free calls", () => {
    for (const response of [
      {},
      { usage: null },
      { usage: { input_tokens: 10, output_tokens: 2 } },
      responseUsage(-1, 2, 0, 0),
      responseUsage(1.5, 2, 0, 0),
      responseUsage(10, 2, 8, 3),
      responseUsage(Number.NaN, 2, 0, 0),
      { usage: { ...responseUsage(10, 2, 0, 0).usage, total_tokens: 99 } },
      { usage: { ...responseUsage(10, 2, 0, 0).usage, output_tokens: "2" } },
    ])
      expect(() => usageOf(response)).toThrow(/usage/);
    const maximum = usageOf(responseUsage(Number.MAX_SAFE_INTEGER, 0, 0, 0));
    expect(() => addUsage(maximum, usageOf(responseUsage(1, 0, 0, 0)))).toThrow(
      "safe integer",
    );
  });

  it("selects one bounded multi-page production coordinate per family", () => {
    const manifest = {
      objects: FAMILIES.flatMap((family) => [
        object(family, 200_000),
        object(family, 130_000),
      ]),
    };
    const selected = selectLiveTrajectoryObjects(manifest);
    expect(selected.map(({ family }) => family)).toEqual(FAMILIES);
    expect(selected.every(({ byteLength }) => byteLength === 130_000)).toBe(
      true,
    );
  });

  it("does not disclose the expected canary or its late offset to the controller", () => {
    for (const family of FAMILIES) {
      const prompt = buildLiveControllerPrompt(family);
      expect(prompt).not.toContain(`SECRET:${family}`);
      expect(prompt).not.toContain("129980");
      expect(prompt).toContain("nextOffset");
    }
  });
});
