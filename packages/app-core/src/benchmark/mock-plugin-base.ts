import {
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  type Plugin,
} from "@elizaos/core";

const DEFAULT_CODE = "00000000-0000-0000-0000-000000000000";

function extractCode(prompt: string, label: string): string {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escapedLabel}:\\s*([0-9a-fA-F-]{36})`);
  const match = regex.exec(prompt);
  return match?.[1] ?? DEFAULT_CODE;
}

function buildJsonResponse(fields: Record<string, string | undefined>): string {
  return Object.entries(fields)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    )
    .map(([key, value]) => {
      if (value.includes("\n")) {
        return `${key}:\n${value
          .split(/\r?\n/)
          .map((line) => `  ${line}`)
          .join("\n")}`;
      }
      return `${key}: ${value}`;
    })
    .join("\n");
}

function createBenchmarkActionJson(prompt: string): string {
  if (
    /Benchmark:\*{0,2}\s*(rlm-bench|rlm_bench)/i.test(prompt) ||
    /RLM benchmark task/i.test(prompt)
  ) {
    const answer =
      /authorization code is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /encrypted key sequence is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /vault combination is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /project identifier is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /access token is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /critical finding reference number is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      "UNKNOWN";
    return buildJsonResponse({
      thought: "Answering the benchmark question directly.",
      actions: "REPLY",
      text: answer,
    });
  }

  if (
    /Benchmark:\*{0,2}\s*gaia/i.test(prompt) ||
    /GAIA benchmark task|FINAL ANSWER/i.test(prompt)
  ) {
    const arithmetic =
      /Question:\s*(?:what is\s*)?(-?\d+)\s*([+*x-])\s*(-?\d+)/i.exec(prompt) ??
      /Question:\s*(?:what is\s*)?(-?\d+)\s+(times|multiplied by|plus|minus)\s+(-?\d+)/i.exec(
        prompt,
      );
    let answer = "mock-answer";
    if (arithmetic) {
      const left = Number(arithmetic[1]);
      const right = Number(arithmetic[3]);
      const op = arithmetic[2].toLowerCase();
      if (op === "+" || op === "plus") answer = String(left + right);
      if (op === "-" || op === "minus") answer = String(left - right);
      if (
        op === "*" ||
        op === "x" ||
        op === "times" ||
        op === "multiplied by"
      ) {
        answer = String(left * right);
      }
    }
    return buildJsonResponse({
      thought: "Answering the GAIA question directly.",
      actions: "REPLY",
      text: `FINAL ANSWER: ${answer}`,
    });
  }

  if (
    /Benchmark:\*{0,2}\s*(hyperliquid_bench|hyperliquid-bench|hyperliquidbench)/i.test(
      prompt,
    ) ||
    /Hyperliquid DEX|HyperliquidBench/i.test(prompt)
  ) {
    return buildJsonResponse({
      thought: "Returning a deterministic Hyperliquid plan.",
      actions: "REPLY",
      text: '{"steps":[{"perp_orders":{"orders":[{"coin":"ETH","side":"buy","tif":"ALO","sz":0.01,"reduceOnly":false,"px":"mid-1%"},{"coin":"BTC","side":"sell","tif":"IOC","sz":0.01,"reduceOnly":true,"px":"mid+1%"}]}},{"usd_class_transfer":{"toPerp":true,"usdc":5}},{"set_leverage":{"coin":"ETH","leverage":3,"cross":false}},{"cancel_all":{"coin":"BTC"}}]}',
    });
  }

  if (
    /Benchmark:\*{0,2}\s*(vending-bench|vending_bench)/i.test(prompt) ||
    /Vending-Bench|vending machine business/i.test(prompt)
  ) {
    const action =
      /pending orders/i.test(prompt) && !/no pending orders/i.test(prompt)
        ? '{"action":"ADVANCE_DAY"}'
        : '{"action":"PLACE_ORDER","supplier_id":"beverage_dist","items":{"water":12}}';
    return buildJsonResponse({
      thought: "Returning a deterministic Vending-Bench action.",
      actions: "REPLY",
      text: action,
    });
  }

  if (
    /Benchmark:\*{0,2}\s*mind2web/i.test(prompt) ||
    /Mind2Web benchmark/i.test(prompt)
  ) {
    const elementId =
      /backend_node_id["'=:\s]+([A-Za-z0-9_-]+)/i.exec(prompt)?.[1] ??
      /"backend_node_id"\s*:\s*"([^"]+)"/i.exec(prompt)?.[1] ??
      "node-1";
    return buildJsonResponse({
      thought: "Clicking the most relevant Mind2Web element.",
      actions: "BENCHMARK_ACTION",
      text: "Selected a web element.",
      params: `BENCHMARK_ACTION:\n  operation: CLICK\n  element_id: ${elementId}\n  value:`,
    });
  }

  if (
    /Benchmark:\*{0,2}\s*(terminal-bench|terminal_bench)/i.test(prompt) ||
    /Terminal-Bench/i.test(prompt)
  ) {
    return buildJsonResponse({
      thought: "Running a safe terminal smoke command.",
      actions: "BENCHMARK_ACTION",
      text: "Running terminal command.",
      params: "BENCHMARK_ACTION:\n  command: echo terminal-bench-smoke",
    });
  }

  if (
    /Benchmark:\*{0,2}\s*osworld/i.test(prompt) ||
    /OSWorld|pyautogui/i.test(prompt)
  ) {
    return buildJsonResponse({
      thought: "Clicking a safe desktop coordinate for OSWorld smoke.",
      actions: "BENCHMARK_ACTION",
      text: "Running pyautogui action.",
      params: "BENCHMARK_ACTION:\n  command: pyautogui.click(10, 10)",
    });
  }

  if (
    /Benchmark:\*{0,2}\s*webshop/i.test(prompt) ||
    /WebShop|simulated webstore|webstore/i.test(prompt)
  ) {
    return buildJsonResponse({
      thought: "Searching for the requested product.",
      actions: "BENCHMARK_ACTION",
      text: "Searching WebShop.",
      params:
        "BENCHMARK_ACTION:\n  command: search[wireless bluetooth headphones]",
    });
  }

  if (
    /Benchmark:\*{0,2}\s*gauntlet/i.test(prompt) ||
    /Solana DeFi safety analyzer/i.test(prompt)
  ) {
    return buildJsonResponse({
      thought: "Returning a conservative Solana safety decision.",
      actions: "REPLY",
      text: "<decision>refuse</decision><reason>Conservative mock safety refusal.</reason><confidence>0.7</confidence>",
    });
  }

  if (
    /Benchmark:\*{0,2}\s*openclaw/i.test(prompt) ||
    /OpenClaw|Node\.js project with TypeScript/i.test(prompt)
  ) {
    return buildJsonResponse({
      thought: "Returning a deterministic OpenClaw conceptual response.",
      actions: "REPLY",
      text: "Initialize the project with npm init, add TypeScript and a tsconfig, create src/ and tests/ directories, add package scripts, and initialize git with a useful .gitignore.",
    });
  }

  if (
    /Benchmark:\*{0,2}\s*clawbench/i.test(prompt) ||
    /ClawBench|Review my inbox/i.test(prompt)
  ) {
    return buildJsonResponse({
      thought: "Returning deterministic ClawBench inbox triage.",
      actions: "REPLY",
      text: "Inbox triage complete. Boss Q4 report is urgent and needs an EOD draft response. HR benefits enrollment is action-required before January 20. BigCorp client email needs scheduling for the project timeline call. Newsletter is low priority and the shopping promo should be archived. Draft replies are ready for review; please approve before I send anything.",
    });
  }

  if (
    /Benchmark:\*{0,2}\s*(swe_bench|swe-bench)/i.test(prompt) ||
    /SWE-bench|Respond with a SINGLE unified diff|Repository: mock\/repo/i.test(
      prompt,
    )
  ) {
    return buildJsonResponse({
      thought: "Returning a deterministic SWE-bench patch.",
      actions: "REPLY",
      text: [
        "diff --git a/hello.py b/hello.py",
        "--- a/hello.py",
        "+++ b/hello.py",
        "@@ -1 +1 @@",
        "-print('hello')",
        "+print('hello swe-bench')",
        "",
      ].join("\n"),
    });
  }

  if (
    /Benchmark:\*{0,2}\s*experience/i.test(prompt) ||
    /RECORD_EXPERIENCE|learns from experience|Recall any relevant past experiences/i.test(
      prompt,
    )
  ) {
    if (
      /phase(?:\\?":|\s*:)\s*"?learning/i.test(prompt) ||
      /RECORD_EXPERIENCE/i.test(prompt)
    ) {
      return buildJsonResponse({
        thought: "Recording the shared learning for later retrieval.",
        actions: "BENCHMARK_ACTION",
        providers: "ELIZA_BENCHMARK",
        text: "RECORD_EXPERIENCE recorded the learning.",
        params: "BENCHMARK_ACTION:\n  command: RECORD_EXPERIENCE",
      });
    }
    return buildJsonResponse({
      thought: "Recalling the most relevant stored experience.",
      actions: "REPLY",
      providers: "ELIZA_BENCHMARK",
      text: "I remember the relevant prior learning.",
    });
  }

  if (
    /Benchmark:\*{0,2}\s*adhdbench/i.test(prompt) ||
    /ADHDBench/i.test(prompt)
  ) {
    const currentMessage =
      /Current user message:\s*([\s\S]*?)(?:\n\n|$)/i
        .exec(prompt)?.[1]
        ?.toLowerCase() ?? prompt.toLowerCase();
    let action = "REPLY";
    if (/send a message|message to/.test(currentMessage))
      action = "SEND_MESSAGE";
    else if (/mute this|too noisy/.test(currentMessage)) action = "MUTE_ROOM";
    else if (/unmute/.test(currentMessage)) action = "UNMUTE_ROOM";
    else if (/follow the/.test(currentMessage)) action = "FOLLOW_ROOM";
    else if (/stop following|unfollow/.test(currentMessage))
      action = "UNFOLLOW_ROOM";
    else if (/find all|search/.test(currentMessage)) action = "SEARCH_CONTACTS";
    else if (/make .* admin|update role/.test(currentMessage))
      action = "UPDATE_ROLE";
    else if (/remind me|tomorrow/.test(currentMessage))
      action = "SCHEDULE_FOLLOW_UP";
    else if (/add .* contact|new colleague/.test(currentMessage))
      action = "ADD_CONTACT";
    else if (/remove .* contact/.test(currentMessage))
      action = "REMOVE_CONTACT";
    else if (/settings|notification preferences/.test(currentMessage))
      action = "UPDATE_SETTINGS";
    else if (/reset|start fresh|clear everything/.test(currentMessage))
      action = "RESET_SESSION";
    else if (/phone number|contact info/.test(currentMessage))
      action = "UPDATE_CONTACT_INFO";
    else if (/generate .*picture|image/.test(currentMessage))
      action = "GENERATE_IMAGE";
    else if (/ignore that last/.test(currentMessage)) action = "IGNORE";
    else if (/create .*plan/.test(currentMessage)) action = "CREATE_PLAN";
    if (["REPLY", "IGNORE", "NONE"].includes(action)) {
      return buildJsonResponse({
        thought: `Selecting ${action} for this ADHDBench turn.`,
        actions: action,
        providers: "RECENT_MESSAGES,ENTITIES,KNOWLEDGE,ROLES",
        text: "Replying directly with the requested information.",
      });
    }
    return buildJsonResponse({
      thought: `Selecting ${action} for this ADHDBench turn.`,
      actions: "BENCHMARK_ACTION",
      providers: "RECENT_MESSAGES,ENTITIES,KNOWLEDGE,ROLES",
      text: `Selected ${action}`,
      params: `BENCHMARK_ACTION:\n  command: ${action}`,
    });
  }

  if (
    /Benchmark:\*{0,2}\s*trust/i.test(prompt) ||
    /security analysis agent|prompt_injection|credential_theft/i.test(prompt)
  ) {
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
    return buildJsonResponse({
      thought: "Returning deterministic Trust benchmark analysis.",
      actions: "REPLY",
      text: JSON.stringify({
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
      }),
    });
  }

  if (
    /Benchmark:\*{0,2}\s*(social_alpha|social-alpha)/i.test(prompt) ||
    /Social-Alpha benchmark|crypto trading signal extraction engine/i.test(
      prompt,
    )
  ) {
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
    return buildJsonResponse({
      thought: "Returning deterministic Social Alpha extraction.",
      actions: "REPLY",
      text: JSON.stringify({
        is_recommendation,
        recommendation_type,
        conviction,
        token_mentioned: ticker,
      }),
    });
  }

  const oneInitialCode = extractCode(prompt, "initial code");
  const oneMiddleCode = extractCode(prompt, "middle code");
  const oneEndCode = extractCode(prompt, "end code");

  return buildJsonResponse({
    thought: "Clicking the target element to progress the benchmark.",
    actions: "BENCHMARK_ACTION",
    text: "Executed CLICK(10,10)",
    params:
      'BENCHMARK_ACTION:\n  operation: CLICK\n  element_id: 10\n  command: CLICK(10,10)\n  tool_name: ui.click\n  arguments: {"x":10,"y":10}',
    one_initial_code: oneInitialCode,
    one_middle_code: oneMiddleCode,
    one_end_code: oneEndCode,
  });
}

/**
 * Tracked fallback mock benchmark plugin.
 *
 * A local-only override can still live at src/benchmark/mock-plugin.ts (gitignored),
 * but this base implementation keeps CI and unit tests deterministic.
 */
export const mockPlugin: Plugin = {
  name: "eliza-benchmark-mock",
  description:
    "Deterministic benchmark mock plugin used by tests and local benchmark smoke runs.",
  models: {
    [ModelType.TEXT_LARGE]: async (
      _runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string> => {
      const prompt =
        typeof params.prompt === "string"
          ? params.prompt
          : JSON.stringify(params.prompt ?? "");

      if (prompt.includes("RESPOND | IGNORE | STOP")) {
        return "action: RESPOND";
      }

      if (prompt.includes("isFinish")) {
        return "isFinish: true";
      }

      return createBenchmarkActionJson(prompt);
    },
  },
};
