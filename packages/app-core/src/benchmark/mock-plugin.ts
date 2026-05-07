import {
  type GenerateTextParams,
  type IAgentRuntime,
  type JsonValue,
  ModelType,
  type ObjectGenerationParams,
  type Plugin,
  type TextEmbeddingParams,
} from "@elizaos/core";

function extractPrompt(
  input:
    | GenerateTextParams
    | string
    | null
    | undefined
    | Record<string, unknown>,
): string {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && typeof input.prompt === "string") {
    return input.prompt;
  }
  const messages =
    input && typeof input === "object" && "messages" in input
      ? (input as { messages?: unknown }).messages
      : undefined;
  if (Array.isArray(messages)) {
    return messages
      .map((message: unknown) => {
        if (typeof message === "string") return message;
        if (message && typeof message === "object" && "content" in message) {
          const content = (message as { content?: unknown }).content;
          return typeof content === "string"
            ? content
            : JSON.stringify(content);
        }
        return JSON.stringify(message);
      })
      .join("\n");
  }
  if (input && typeof input === "object") {
    try {
      return JSON.stringify(input);
    } catch {
      return "";
    }
  }
  return "";
}

function extractCommand(prompt: string): string {
  const match = prompt.match(/CLICK\([^)]*\)/i);
  if (match?.[0]) {
    return match[0].toUpperCase();
  }
  return "CLICK(10,10)";
}

function extractRlmAnswer(prompt: string): string | null {
  const pairs = [
    /authorization code is ([A-Z0-9]{8})/i,
    /encrypted key sequence is ([A-Z0-9]{8})/i,
    /vault combination is ([A-Z0-9]{8})/i,
    /project identifier is ([A-Z0-9]{8})/i,
    /access token is ([A-Z0-9]{8})/i,
    /critical finding reference number is ([A-Z0-9]{8})/i,
  ];
  for (const regex of pairs) {
    const match = regex.exec(prompt);
    if (match?.[1]) return match[1];
  }

  const shared = /shared protocol version is ([A-Z0-9]{8})/i.exec(prompt)?.[1];
  const docA = /document A identifier is ([A-Z0-9]{8})/i.exec(prompt)?.[1];
  const docB = /document B identifier is ([A-Z0-9]{8})/i.exec(prompt)?.[1];
  if (shared && docA && docB) {
    return `Shared: ${shared}, A: ${docA}, B: ${docB}`;
  }

  const allNeedles = Array.from(
    prompt.matchAll(
      /(?:authorization code|encrypted key sequence|vault combination|project identifier|access token) is ([A-Z0-9]{8})/gi,
    ),
    (match) => match[1],
  );
  if (allNeedles.length > 0) {
    return Array.from(new Set(allNeedles)).join(", ");
  }
  return null;
}

function extractArithmeticAnswer(prompt: string): string | null {
  const match =
    /Question:\s*(?:what is\s*)?(-?\d+)\s*([+*x-])\s*(-?\d+)/i.exec(prompt) ??
    /Question:\s*(?:what is\s*)?(-?\d+)\s+(times|multiplied by|plus|minus)\s+(-?\d+)/i.exec(
      prompt,
    );
  if (!match) return null;
  const left = Number(match[1]);
  const op = match[2].toLowerCase();
  const right = Number(match[3]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  if (op === "+" || op === "plus") return String(left + right);
  if (op === "-" || op === "minus") return String(left - right);
  if (op === "*" || op === "x" || op === "times" || op === "multiplied by") {
    return String(left * right);
  }
  return null;
}

function buildReplyJson(answer: string): string {
  return buildJsonResponse("", {
    thought: "Answering the benchmark question directly.",
    actions: "REPLY",
    providers: "",
    text: answer,
  });
}

function buildHyperliquidPlanJson(): string {
  const plan = {
    steps: [
      {
        perp_orders: {
          orders: [
            {
              coin: "ETH",
              side: "buy",
              tif: "ALO",
              sz: 0.01,
              reduceOnly: false,
              px: "mid-1%",
            },
            {
              coin: "BTC",
              side: "sell",
              tif: "IOC",
              sz: 0.01,
              reduceOnly: true,
              px: "mid+1%",
            },
          ],
        },
      },
      { usd_class_transfer: { toPerp: true, usdc: 5 } },
      { set_leverage: { coin: "ETH", leverage: 3, cross: false } },
      { cancel_all: { coin: "BTC" } },
    ],
  };
  return buildReplyJson(JSON.stringify(plan));
}

function buildVendingActionJson(prompt: string): string {
  const hasPending =
    /pending orders/i.test(prompt) && !/no pending orders/i.test(prompt);
  const action = hasPending
    ? { action: "ADVANCE_DAY" }
    : {
        action: "PLACE_ORDER",
        supplier_id: "beverage_dist",
        items: { water: 12 },
        reasoning: "Initial stock order for a high-demand product.",
      };
  return buildReplyJson(JSON.stringify(action));
}

function buildClawBenchReplyJson(): string {
  return buildReplyJson(
    [
      "Inbox triage complete.",
      "Boss Q4 report is urgent and needs an EOD draft response.",
      "HR benefits enrollment is action-required before January 20.",
      "BigCorp client email needs scheduling for the project timeline call.",
      "Newsletter is low priority and the shopping promo should be archived.",
      "Draft replies are ready for review; please approve before I send anything.",
    ].join(" "),
  );
}

function buildSweBenchReplyJson(): string {
  return buildReplyJson(
    [
      "diff --git a/hello.py b/hello.py",
      "--- a/hello.py",
      "+++ b/hello.py",
      "@@ -1 +1 @@",
      "-print('hello')",
      "+print('hello swe-bench')",
      "",
    ].join("\n"),
  );
}

function buildExperienceJson(prompt: string): string {
  if (
    /phase(?:\\?":|\s*:)\s*"?learning/i.test(prompt) ||
    /RECORD_EXPERIENCE/i.test(prompt)
  ) {
    return buildJsonResponse(prompt, {
      thought: "Recording the shared learning for later retrieval.",
      actions: "BENCHMARK_ACTION",
      providers: "ELIZA_BENCHMARK",
      text: "RECORD_EXPERIENCE recorded the learning.",
      params: "BENCHMARK_ACTION:\n  command: RECORD_EXPERIENCE",
    });
  }

  const expectedLearning =
    /expected_learning(?:\\?":|\s*:)\s*"?([^"\n]+)/i
      .exec(prompt)?.[1]
      ?.trim() ?? "the relevant prior learning";
  return buildJsonResponse(prompt, {
    thought: "Recalling the most relevant stored experience.",
    actions: "REPLY",
    providers: "ELIZA_BENCHMARK",
    text: `I remember ${expectedLearning}.`,
  });
}

function extractAdhdAction(prompt: string): string {
  const lower = prompt.toLowerCase();
  const messageMatch = /Current user message:\s*([\s\S]*?)(?:\n\n|$)/i.exec(
    prompt,
  );
  const message = (messageMatch?.[1] ?? prompt).toLowerCase();
  if (
    /what time|hello|hey|how are|favourite color|favorite color|status update/.test(
      message,
    )
  ) {
    return "REPLY";
  }
  if (/send a message|tell alice|message to/.test(message))
    return "SEND_MESSAGE";
  if (/mute this|too noisy/.test(message)) return "MUTE_ROOM";
  if (/unmute/.test(message)) return "UNMUTE_ROOM";
  if (/follow the/.test(message)) return "FOLLOW_ROOM";
  if (/stop following|unfollow/.test(message)) return "UNFOLLOW_ROOM";
  if (/find all|search/.test(message)) return "SEARCH_CONTACTS";
  if (/make .* admin|update role/.test(message)) return "UPDATE_ROLE";
  if (/remind me|follow.?up|tomorrow/.test(message))
    return "SCHEDULE_FOLLOW_UP";
  if (/add .* contact|add my new colleague/.test(message)) return "ADD_CONTACT";
  if (/remove .* contact/.test(message)) return "REMOVE_CONTACT";
  if (/notification preferences|settings/.test(message))
    return "UPDATE_SETTINGS";
  if (/clear everything|start fresh|reset/.test(message))
    return "RESET_SESSION";
  if (/phone number|contact info/.test(message)) return "UPDATE_CONTACT_INFO";
  if (/generate .*picture|image/.test(message)) return "GENERATE_IMAGE";
  if (/ignore that last/.test(message)) return "IGNORE";
  if (/create .*plan|detailed plan/.test(message)) return "CREATE_PLAN";
  return lower.includes("reply") ? "REPLY" : "REPLY";
}

function buildAdhdBenchJson(prompt: string): string {
  const action = extractAdhdAction(prompt);
  const text =
    action === "REPLY"
      ? "Replying directly with the requested information."
      : `Selected ${action}`;
  if (["REPLY", "IGNORE", "NONE"].includes(action)) {
    return buildJsonResponse(prompt, {
      thought: `Selecting ${action} for this ADHDBench turn.`,
      actions: action,
      providers: "RECENT_MESSAGES,ENTITIES,KNOWLEDGE,ROLES",
      text,
    });
  }
  return buildJsonResponse(prompt, {
    thought: `Selecting ${action} for this ADHDBench turn.`,
    actions: "BENCHMARK_ACTION",
    providers: "RECENT_MESSAGES,ENTITIES,KNOWLEDGE,ROLES",
    text,
    params: `BENCHMARK_ACTION:\n  command: ${action}`,
  });
}

function extractMind2WebElementId(prompt: string): string {
  return (
    /backend_node_id["'=:\s]+([A-Za-z0-9_-]+)/i.exec(prompt)?.[1] ??
    /"backend_node_id"\s*:\s*"([^"]+)"/i.exec(prompt)?.[1] ??
    "node-1"
  );
}

function buildMind2WebActionJson(prompt: string): string {
  return buildJsonResponse(prompt, {
    thought: "Clicking the most relevant Mind2Web element.",
    actions: "BENCHMARK_ACTION",
    providers: "",
    text: "Selected a web element.",
    params: `BENCHMARK_ACTION:\n  operation: CLICK\n  element_id: ${extractMind2WebElementId(prompt)}\n  value:`,
  });
}

function buildTerminalCommandJson(prompt: string): string {
  return buildJsonResponse(prompt, {
    thought: "Running a safe terminal smoke command.",
    actions: "BENCHMARK_ACTION",
    providers: "",
    text: "Running terminal command.",
    params: "BENCHMARK_ACTION:\n  command: echo terminal-bench-smoke",
  });
}

function buildOSWorldActionJson(prompt: string): string {
  return buildJsonResponse(prompt, {
    thought: "Clicking a safe desktop coordinate for OSWorld smoke.",
    actions: "BENCHMARK_ACTION",
    providers: "",
    text: "Running pyautogui action.",
    params: "BENCHMARK_ACTION:\n  command: pyautogui.click(10, 10)",
  });
}

function buildWebShopActionJson(prompt: string): string {
  return buildJsonResponse(prompt, {
    thought: "Searching for the requested product.",
    actions: "BENCHMARK_ACTION",
    providers: "",
    text: "Searching WebShop.",
    params:
      "BENCHMARK_ACTION:\n  command: search[wireless bluetooth headphones]",
  });
}

function buildGauntletDecisionJson(prompt: string): string {
  return buildJsonResponse(prompt, {
    thought: "Returning a conservative Solana safety decision.",
    actions: "REPLY",
    providers: "",
    text: "<decision>refuse</decision><reason>Conservative mock safety refusal.</reason><confidence>0.7</confidence>",
  });
}

function buildOpenClawReplyJson(prompt: string): string {
  return buildJsonResponse(prompt, {
    thought: "Returning a deterministic OpenClaw conceptual response.",
    actions: "REPLY",
    providers: "",
    text: "Initialize the project with npm init, add TypeScript and a tsconfig, create src/ and tests/ directories, add package scripts, and initialize git with a useful .gitignore.",
  });
}

function buildTrustAnalysisJson(prompt: string): string {
  const message =
    /## Message to Analyze\s*"""([\s\S]*?)"""/i.exec(prompt)?.[1] ??
    /"message"\s*:\s*"([^"]*)"/i.exec(prompt)?.[1] ??
    prompt;
  const lower = message.toLowerCase();
  const promptInjection =
    /ignore|disregard|previous instructions|new instructions|system override|system command|dan|bypass|jailbreak/.test(
      lower,
    );
  const privilege = /admin|owner|root|privilege|permissions|elevate/.test(
    lower,
  );
  const analysis = {
    prompt_injection: {
      detected: promptInjection,
      confidence: promptInjection ? 0.95 : 0.05,
    },
    social_engineering: { detected: false, confidence: 0.05 },
    credential_theft: { detected: false, confidence: 0.05 },
    privilege_escalation: {
      detected: privilege,
      confidence: privilege ? 0.8 : 0.05,
    },
    data_exfiltration: { detected: false, confidence: 0.05 },
    resource_abuse: { detected: false, confidence: 0.05 },
    content_policy: { detected: false, confidence: 0.05 },
  };
  return buildJsonResponse(prompt, {
    thought: "Returning deterministic Trust benchmark analysis.",
    actions: "REPLY",
    providers: "",
    text: JSON.stringify(analysis),
  });
}

function buildSocialAlphaExtractionJson(prompt: string): string {
  const message =
    /Message:\s*([\s\S]*?)(?:\n\nBENCHMARK CONTEXT|\n\nRespond|$)/i.exec(
      prompt,
    )?.[1] ?? prompt;
  const lower = message.toLowerCase();
  const ticker = /\$([A-Z][A-Z0-9]{1,12})/.exec(message)?.[1] ?? "";
  const sell = /sell|dump|short|avoid|bearish|rug|scam/.test(lower);
  const buy = /buy|moon|pump|bullish|long|ape|gem|alpha|100x/.test(lower);
  const recommendation_type =
    buy && !sell ? "BUY" : sell && !buy ? "SELL" : "NOISE";
  const is_recommendation = recommendation_type !== "NOISE";
  const conviction = is_recommendation
    ? /100x|moon|ape|strong|high|gem|alpha/.test(lower)
      ? "HIGH"
      : "MEDIUM"
    : "NONE";
  return buildJsonResponse(prompt, {
    thought: "Returning deterministic Social Alpha extraction.",
    actions: "REPLY",
    providers: "",
    text: JSON.stringify({
      is_recommendation,
      recommendation_type,
      conviction,
      token_mentioned: ticker,
    }),
  });
}

function extractValidationFields(prompt: string): Record<string, string> {
  const tags: Record<string, string> = {};

  const matches = prompt.matchAll(
    /"(code_[A-Za-z0-9_-]+_(?:start|end)|one_(?:initial|middle|end)_code|two_(?:initial|middle|end)_code)"\s*:\s*"([^"]+)"/g,
  );
  for (const [, key, value] of matches) {
    tags[key] = value.trim();
  }

  // Checkpoint validation codes are also rendered in plain text lines:
  // "initial code: ...", "middle code: ...", "end code: ..."
  // and optionally "second initial code: ..." for the second checkpoint set.
  const checkpointMatches = prompt.matchAll(
    /(second\s+)?(initial|middle|end)\s+code:\s*([a-f0-9-]{8,})/gi,
  );
  for (const [, second, stage, value] of checkpointMatches) {
    const prefix = second ? "two" : "one";
    tags[`${prefix}_${stage.toLowerCase()}_code`] = value.trim();
  }

  return tags;
}

function buildJsonResponse(
  prompt: string,
  fields: Record<string, string | undefined>,
): string {
  const withValidation = { ...fields, ...extractValidationFields(prompt) };
  const entries = Object.entries(withValidation).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
  );
  return entries.map(([key, value]) => renderJsonField(key, value)).join("\n");
}

function renderJsonField(key: string, value: string): string {
  if (value.includes("\n")) {
    return `${key}:\n${value
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join("\n")}`;
  }
  return `${key}: ${value}`;
}

function buildCompletion(prompt: string): string {
  const command = extractCommand(prompt);

  // shouldRespondTemplate
  if (prompt.includes("Decide on behalf of") && prompt.includes("RESPOND")) {
    return buildJsonResponse(prompt, {
      name: "BenchmarkAgent",
      reasoning: "Benchmark requests should always be processed.",
      action: "RESPOND",
    });
  }

  // Legacy native planner decision prompt
  if (
    prompt.includes("Determine the next step") &&
    prompt.includes("isFinish")
  ) {
    return buildJsonResponse(prompt, {
      thought: "The benchmark task can be completed in this step.",
      action: "",
      providers: "",
      isFinish: "true",
    });
  }

  // Legacy native response prompt
  if (prompt.includes("Summarize what the assistant has done so far")) {
    return buildJsonResponse(prompt, {
      thought: "Summarizing completed benchmark execution.",
      text: `Executed ${command}`,
    });
  }

  if (
    /Benchmark:\*{0,2}\s*(rlm-bench|rlm_bench)/i.test(prompt) ||
    /RLM benchmark task/i.test(prompt)
  ) {
    return buildReplyJson(extractRlmAnswer(prompt) ?? "UNKNOWN");
  }

  if (
    /Benchmark:\*{0,2}\s*gaia/i.test(prompt) ||
    /GAIA benchmark task|FINAL ANSWER/i.test(prompt)
  ) {
    const answer = extractArithmeticAnswer(prompt) ?? "mock-answer";
    return buildReplyJson(`FINAL ANSWER: ${answer}`);
  }

  if (
    /Benchmark:\*{0,2}\s*(hyperliquid_bench|hyperliquid-bench|hyperliquidbench)/i.test(
      prompt,
    ) ||
    /Hyperliquid DEX|HyperliquidBench/i.test(prompt)
  ) {
    return buildHyperliquidPlanJson();
  }

  if (
    /Benchmark:\*{0,2}\s*(vending-bench|vending_bench)/i.test(prompt) ||
    /Vending-Bench|vending machine business/i.test(prompt)
  ) {
    return buildVendingActionJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*mind2web/i.test(prompt) ||
    /Mind2Web benchmark/i.test(prompt)
  ) {
    return buildMind2WebActionJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*(terminal-bench|terminal_bench)/i.test(prompt) ||
    /Terminal-Bench/i.test(prompt)
  ) {
    return buildTerminalCommandJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*osworld/i.test(prompt) ||
    /OSWorld|pyautogui/i.test(prompt)
  ) {
    return buildOSWorldActionJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*webshop/i.test(prompt) ||
    /WebShop|simulated webstore|webstore/i.test(prompt)
  ) {
    return buildWebShopActionJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*gauntlet/i.test(prompt) ||
    /Solana DeFi safety analyzer/i.test(prompt)
  ) {
    return buildGauntletDecisionJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*openclaw/i.test(prompt) ||
    /OpenClaw|Node\.js project with TypeScript/i.test(prompt)
  ) {
    return buildOpenClawReplyJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*clawbench/i.test(prompt) ||
    /ClawBench|Review my inbox/i.test(prompt)
  ) {
    return buildClawBenchReplyJson();
  }

  if (
    /Benchmark:\*{0,2}\s*(swe_bench|swe-bench)/i.test(prompt) ||
    /SWE-bench|Respond with a SINGLE unified diff|Repository: mock\/repo/i.test(
      prompt,
    )
  ) {
    return buildSweBenchReplyJson();
  }

  if (
    /Benchmark:\*{0,2}\s*experience/i.test(prompt) ||
    /RECORD_EXPERIENCE|learns from experience|Recall any relevant past experiences/i.test(
      prompt,
    )
  ) {
    return buildExperienceJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*adhdbench/i.test(prompt) ||
    /ADHDBench/i.test(prompt)
  ) {
    return buildAdhdBenchJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*trust/i.test(prompt) ||
    /security analysis agent|prompt_injection|credential_theft/i.test(prompt)
  ) {
    return buildTrustAnalysisJson(prompt);
  }

  if (
    /Benchmark:\*{0,2}\s*(social_alpha|social-alpha)/i.test(prompt) ||
    /Social-Alpha benchmark|crypto trading signal extraction engine/i.test(
      prompt,
    )
  ) {
    return buildSocialAlphaExtractionJson(prompt);
  }

  return buildJsonResponse(prompt, {
    thought: `Execute deterministic benchmark action using ${command}.`,
    actions: "BENCHMARK_ACTION",
    providers: "",
    text: `Executed ${command}`,
    params: `BENCHMARK_ACTION:\n  command: ${command}`,
  });
}

function mockTextModel(
  _runtime: IAgentRuntime,
  params: GenerateTextParams | string | null,
): string {
  return buildCompletion(extractPrompt(params));
}

function mockEmbeddingModel(
  _runtime: IAgentRuntime,
  _params: TextEmbeddingParams | string | null,
): number[] {
  const vector = new Array(384).fill(0);
  vector[0] = 1;
  return vector;
}

function mockObjectModel(
  _runtime: IAgentRuntime,
  params: ObjectGenerationParams,
): Record<string, JsonValue> {
  const prompt = extractPrompt(params.prompt ?? params);
  const command = extractCommand(prompt);
  const replyJson =
    /Benchmark:\*{0,2}\s*trust/i.test(prompt) ||
    /security analysis agent|prompt_injection|credential_theft/i.test(prompt)
      ? buildTrustAnalysisJson(prompt)
      : /Benchmark:\*{0,2}\s*(social_alpha|social-alpha)/i.test(prompt) ||
          /Social-Alpha benchmark|crypto trading signal extraction engine/i.test(
            prompt,
          )
        ? buildSocialAlphaExtractionJson(prompt)
        : null;
  if (replyJson) {
    const text = /^text:\s*(.*)$/m.exec(replyJson)?.[1] ?? "";
    const thought = /^thought:\s*(.*)$/m.exec(replyJson)?.[1] ?? "";
    return {
      thought,
      reasoning: thought,
      actions: ["REPLY"],
      name: "REPLY",
      action: "REPLY",
      params: {},
      text,
      isFinish: true,
    };
  }
  const schemaProps =
    params.schema && typeof params.schema.properties === "object"
      ? params.schema.properties
      : undefined;

  const fallback: Record<string, JsonValue> = {
    thought: "Execute deterministic benchmark action",
    actions: ["BENCHMARK_ACTION"],
    name: "BENCHMARK_ACTION",
    reasoning: "Execute deterministic benchmark action",
    action: "BENCHMARK_ACTION",
    params: {
      BENCHMARK_ACTION: {
        command,
      },
    },
    text: `Executed ${command}`,
    isFinish: true,
  };

  if (!schemaProps) {
    return fallback;
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, schema] of Object.entries(schemaProps)) {
    const fieldType =
      schema && typeof schema === "object" && "type" in schema
        ? schema.type
        : undefined;
    const normalizedType =
      typeof fieldType === "string"
        ? fieldType
        : Array.isArray(fieldType) && typeof fieldType[0] === "string"
          ? fieldType[0]
          : undefined;

    if (
      key === "action" ||
      key === "name" ||
      key === "actions" ||
      key.toLowerCase().includes("action")
    ) {
      output[key] =
        normalizedType === "array" ? ["BENCHMARK_ACTION"] : "BENCHMARK_ACTION";
      continue;
    }
    if (
      key === "reasoning" ||
      key === "thought" ||
      key.toLowerCase().includes("reason")
    ) {
      output[key] = "Execute deterministic benchmark action";
      continue;
    }
    if (key === "params" || key.toLowerCase().includes("param")) {
      output[key] = { BENCHMARK_ACTION: { command } };
      continue;
    }
    if (key === "text" || key.toLowerCase().includes("message")) {
      output[key] = `Executed ${command}`;
      continue;
    }

    if (normalizedType === "boolean") {
      output[key] = false;
    } else if (normalizedType === "number" || normalizedType === "integer") {
      output[key] = 1;
    } else if (normalizedType === "array") {
      output[key] = [];
    } else if (normalizedType === "object") {
      output[key] = {};
    } else {
      output[key] = "ok";
    }
  }

  return { ...fallback, ...output };
}

export const mockPlugin: Plugin = {
  name: "mock-plugin",
  description: "Deterministic benchmark plugin for offline benchmark runs",
  priority: 1000,
  models: {
    [ModelType.TEXT_SMALL]: async (runtime, params) =>
      mockTextModel(runtime, params),
    [ModelType.TEXT_LARGE]: async (runtime, params) =>
      mockTextModel(runtime, params),
    [ModelType.TEXT_COMPLETION]: async (runtime, params) =>
      mockTextModel(runtime, params),
    [ModelType.OBJECT_SMALL]: async (runtime, params) =>
      mockObjectModel(runtime, params),
    [ModelType.OBJECT_LARGE]: async (runtime, params) =>
      mockObjectModel(runtime, params),
    [ModelType.TEXT_EMBEDDING]: async (runtime, params) =>
      mockEmbeddingModel(runtime, params),
  },
};
