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

function createBenchmarkActionXml(prompt: string): string {
  if (/Benchmark:\*{0,2}\s*(rlm-bench|rlm_bench)/i.test(prompt) || /RLM benchmark task/i.test(prompt)) {
    const answer =
      /authorization code is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /encrypted key sequence is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /vault combination is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /project identifier is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /access token is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      /critical finding reference number is ([A-Z0-9]{8})/i.exec(prompt)?.[1] ??
      "UNKNOWN";
    return [
      "<response>",
      "<thought>Answering the benchmark question directly.</thought>",
      "<actions>REPLY</actions>",
      `<text><answer>${answer}</answer></text>`,
      "</response>",
    ].join("\n");
  }

  if (/Benchmark:\*{0,2}\s*gaia/i.test(prompt) || /GAIA benchmark task|FINAL ANSWER/i.test(prompt)) {
    const arithmetic =
      /Question:\s*(?:what is\s*)?(-?\d+)\s*([+*x-])\s*(-?\d+)/i.exec(prompt) ??
      /Question:\s*(?:what is\s*)?(-?\d+)\s+(times|multiplied by|plus|minus)\s+(-?\d+)/i.exec(prompt);
    let answer = "mock-answer";
    if (arithmetic) {
      const left = Number(arithmetic[1]);
      const right = Number(arithmetic[3]);
      const op = arithmetic[2].toLowerCase();
      if (op === "+" || op === "plus") answer = String(left + right);
      if (op === "-" || op === "minus") answer = String(left - right);
      if (op === "*" || op === "x" || op === "times" || op === "multiplied by") {
        answer = String(left * right);
      }
    }
    return [
      "<response>",
      "<thought>Answering the GAIA question directly.</thought>",
      "<actions>REPLY</actions>",
      `<text>FINAL ANSWER: ${answer}</text>`,
      "</response>",
    ].join("\n");
  }

  if (/Benchmark:\*{0,2}\s*(hyperliquid_bench|hyperliquid-bench|hyperliquidbench)/i.test(prompt) || /Hyperliquid DEX|HyperliquidBench/i.test(prompt)) {
    return [
      "<response>",
      "<thought>Returning a deterministic Hyperliquid plan.</thought>",
      "<actions>REPLY</actions>",
      '<text>{"steps":[{"perp_orders":{"orders":[{"coin":"ETH","side":"buy","tif":"ALO","sz":0.01,"reduceOnly":false,"px":"mid-1%"},{"coin":"BTC","side":"sell","tif":"IOC","sz":0.01,"reduceOnly":true,"px":"mid+1%"}]}},{"usd_class_transfer":{"toPerp":true,"usdc":5}},{"set_leverage":{"coin":"ETH","leverage":3,"cross":false}},{"cancel_all":{"coin":"BTC"}}]}</text>',
      "</response>",
    ].join("\n");
  }

  if (/Benchmark:\*{0,2}\s*(vending-bench|vending_bench)/i.test(prompt) || /Vending-Bench|vending machine business/i.test(prompt)) {
    const action = /pending orders/i.test(prompt) && !/no pending orders/i.test(prompt)
      ? '{"action":"ADVANCE_DAY"}'
      : '{"action":"PLACE_ORDER","supplier_id":"beverage_dist","items":{"water":12}}';
    return [
      "<response>",
      "<thought>Returning a deterministic Vending-Bench action.</thought>",
      "<actions>REPLY</actions>",
      `<text>${action}</text>`,
      "</response>",
    ].join("\n");
  }

  if (/Benchmark:\*{0,2}\s*clawbench/i.test(prompt) || /ClawBench|Review my inbox/i.test(prompt)) {
    return [
      "<response>",
      "<thought>Returning deterministic ClawBench inbox triage.</thought>",
      "<actions>REPLY</actions>",
      "<text>Inbox triage complete. Boss Q4 report is urgent and needs an EOD draft response. HR benefits enrollment is action-required before January 20. BigCorp client email needs scheduling for the project timeline call. Newsletter is low priority and the shopping promo should be archived. Draft replies are ready for review; please approve before I send anything.</text>",
      "</response>",
    ].join("\n");
  }

  if (/Benchmark:\*{0,2}\s*adhdbench/i.test(prompt) || /ADHDBench/i.test(prompt)) {
    const currentMessage = /Current user message:\s*([\s\S]*?)(?:\n\n|$)/i.exec(prompt)?.[1]?.toLowerCase() ?? prompt.toLowerCase();
    let action = "REPLY";
    if (/send a message|message to/.test(currentMessage)) action = "SEND_MESSAGE";
    else if (/mute this|too noisy/.test(currentMessage)) action = "MUTE_ROOM";
    else if (/unmute/.test(currentMessage)) action = "UNMUTE_ROOM";
    else if (/follow the/.test(currentMessage)) action = "FOLLOW_ROOM";
    else if (/stop following|unfollow/.test(currentMessage)) action = "UNFOLLOW_ROOM";
    else if (/find all|search/.test(currentMessage)) action = "SEARCH_CONTACTS";
    else if (/make .* admin|update role/.test(currentMessage)) action = "UPDATE_ROLE";
    else if (/remind me|tomorrow/.test(currentMessage)) action = "SCHEDULE_FOLLOW_UP";
    else if (/add .* contact|new colleague/.test(currentMessage)) action = "ADD_CONTACT";
    else if (/remove .* contact/.test(currentMessage)) action = "REMOVE_CONTACT";
    else if (/settings|notification preferences/.test(currentMessage)) action = "UPDATE_SETTINGS";
    else if (/reset|start fresh|clear everything/.test(currentMessage)) action = "RESET_SESSION";
    else if (/phone number|contact info/.test(currentMessage)) action = "UPDATE_CONTACT_INFO";
    else if (/generate .*picture|image/.test(currentMessage)) action = "GENERATE_IMAGE";
    else if (/ignore that last/.test(currentMessage)) action = "IGNORE";
    else if (/create .*plan/.test(currentMessage)) action = "CREATE_PLAN";
    if (["REPLY", "IGNORE", "NONE"].includes(action)) {
      return [
        "<response>",
        `<thought>Selecting ${action} for this ADHDBench turn.</thought>`,
        `<actions>${action}</actions>`,
        "<providers>RECENT_MESSAGES,ENTITIES,KNOWLEDGE,ROLES</providers>",
        "<text>Replying directly with the requested information.</text>",
        "</response>",
      ].join("\n");
    }
    return [
      "<response>",
      `<thought>Selecting ${action} for this ADHDBench turn.</thought>`,
      "<actions>BENCHMARK_ACTION</actions>",
      "<providers>RECENT_MESSAGES,ENTITIES,KNOWLEDGE,ROLES</providers>",
      `<text>Selected ${action}</text>`,
      "<params>",
      "<BENCHMARK_ACTION>",
      `<command>${action}</command>`,
      "</BENCHMARK_ACTION>",
      "</params>",
      "</response>",
    ].join("\n");
  }

  const oneInitialCode = extractCode(prompt, "initial code");
  const oneMiddleCode = extractCode(prompt, "middle code");
  const oneEndCode = extractCode(prompt, "end code");

  return [
    "<response>",
    "<thought>Clicking the target element to progress the benchmark.</thought>",
    "<actions>BENCHMARK_ACTION</actions>",
    "<text>Executed CLICK(10,10)</text>",
    "<params>",
    "<BENCHMARK_ACTION>",
    "<operation>CLICK</operation>",
    "<element_id>10</element_id>",
    "<value></value>",
    "<command>CLICK(10,10)</command>",
    "<tool_name>ui.click</tool_name>",
    '<arguments>{"x":10,"y":10}</arguments>',
    "</BENCHMARK_ACTION>",
    "</params>",
    `<one_initial_code>${oneInitialCode}</one_initial_code>`,
    `<one_middle_code>${oneMiddleCode}</one_middle_code>`,
    `<one_end_code>${oneEndCode}</one_end_code>`,
    "</response>",
  ].join("\n");
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
        return "<response><action>RESPOND</action></response>";
      }

      if (prompt.includes("<isFinish>true | false</isFinish>")) {
        return "<response><isFinish>true</isFinish></response>";
      }

      return createBenchmarkActionXml(prompt);
    },
  },
};
