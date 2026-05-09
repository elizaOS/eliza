import { describe, test, expect } from "bun:test";
import {
  searchNodes,
  filterNodesByIntegrationSupport,
  simplifyNodeForLLM,
  getNodeDefinition,
} from "../../src/utils/catalog";

describe("searchNodes", () => {
  test("returns empty array for empty keywords", () => {
    const results = searchNodes([]);
    expect(results).toEqual([]);
  });

  test("finds Gmail node by exact keyword", () => {
    const results = searchNodes(["gmail"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].node.name.toLowerCase()).toContain("gmail");
    expect(results[0].score).toBeGreaterThanOrEqual(5);
  });

  test("finds Slack node by keyword", () => {
    const results = searchNodes(["slack"]);
    expect(results.length).toBeGreaterThan(0);
    const slackNode = results.find((r) =>
      r.node.name.toLowerCase().includes("slack"),
    );
    expect(slackNode).not.toBeUndefined();
    expect(slackNode!.score).toBeGreaterThanOrEqual(5);
  });

  test("finds nodes by multiple keywords", () => {
    const results = searchNodes(["gmail", "send", "email"]);
    expect(results.length).toBeGreaterThan(0);
    // Gmail should score high with multiple keyword matches
    const gmailResult = results.find((r) =>
      r.node.name.toLowerCase().includes("gmail"),
    );
    expect(gmailResult).toBeDefined();
    expect(gmailResult!.score).toBeGreaterThanOrEqual(5);
  });

  test("respects limit parameter", () => {
    const results = searchNodes(["send"], 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("returns results sorted by score descending", () => {
    const results = searchNodes(["http", "request"]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  test("filters out zero-score nodes", () => {
    const results = searchNodes(["xyznonexistentnode"]);
    expect(results.length).toBe(0);
  });

  test("handles case insensitivity", () => {
    const lower = searchNodes(["gmail"]);
    const upper = searchNodes(["GMAIL"]);
    const mixed = searchNodes(["Gmail"]);
    // All should find the same nodes
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBe(mixed.length);
  });

  test("finds trigger nodes", () => {
    const results = searchNodes(["schedule", "trigger"]);
    expect(results.length).toBeGreaterThan(0);
    const triggerNode = results.find(
      (r) =>
        r.node.name.toLowerCase().includes("schedule") ||
        r.node.name.toLowerCase().includes("trigger"),
    );
    expect(triggerNode).toBeDefined();
  });

  test("includes match reason for scored nodes", () => {
    const results = searchNodes(["webhook"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].matchReason).not.toBe("no strong match");
  });

  test("scores exact name match higher than partial", () => {
    // Search for a term that has both exact and partial matches
    const results = searchNodes(["http"]);
    if (results.length >= 2) {
      // Node with exact match should appear before partial match
      const exactMatch = results.find(
        (r) =>
          r.node.name.toLowerCase() === "http" ||
          r.node.displayName.toLowerCase() === "http",
      );
      const partialMatch = results.find(
        (r) =>
          r.node.name.toLowerCase() !== "http" &&
          r.node.displayName.toLowerCase() !== "http" &&
          (r.node.name.toLowerCase().includes("http") ||
            r.node.displayName.toLowerCase().includes("http")),
      );
      if (exactMatch && partialMatch) {
        expect(exactMatch.score).toBeGreaterThan(partialMatch.score);
      }
    }
  });

  test("default limit is 15", () => {
    // Use a very generic keyword that matches many nodes
    const results = searchNodes(["data"]);
    expect(results.length).toBeLessThanOrEqual(15);
  });

  test("finds OpenAI node by keyword", () => {
    const results = searchNodes(["openai"]);
    expect(results.length).toBeGreaterThan(0);
    const openAiNode = results.find(
      (r) => r.node.name === "@n8n/n8n-nodes-langchain.openAi",
    );
    expect(openAiNode).toBeDefined();
    expect(openAiNode!.node.credentials).toContainEqual(
      expect.objectContaining({ name: "openAiApi" }),
    );
  });

  test("finds OpenAI node with AI-related keywords", () => {
    const results = searchNodes(["ai", "openai"]);
    const openAiNode = results.find(
      (r) => r.node.name === "@n8n/n8n-nodes-langchain.openAi",
    );
    expect(openAiNode).toBeDefined();
  });
});

describe("filterNodesByIntegrationSupport", () => {
  test("keeps nodes with supported credentials", () => {
    const nodes = searchNodes(["gmail", "openai"], 10);
    const supported = new Set(["gmailOAuth2Api", "openAiApi"]);
    const { remaining, removed } = filterNodesByIntegrationSupport(
      nodes,
      supported,
    );

    // OpenAI and Gmail nodes should remain
    const openAi = remaining.find(
      (r) => r.node.name === "@n8n/n8n-nodes-langchain.openAi",
    );
    expect(openAi).toBeDefined();
    expect(
      removed.find((r) => r.node.name === "@n8n/n8n-nodes-langchain.openAi"),
    ).toBeUndefined();
  });

  test("removes nodes with unsupported credentials", () => {
    const nodes = searchNodes(["openai"], 10);
    const supported = new Set<string>(); // nothing supported
    const { remaining, removed } = filterNodesByIntegrationSupport(
      nodes,
      supported,
    );

    const openAiRemoved = removed.find(
      (r) => r.node.name === "@n8n/n8n-nodes-langchain.openAi",
    );
    expect(openAiRemoved).toBeDefined();
    expect(
      remaining.find((r) => r.node.name === "@n8n/n8n-nodes-langchain.openAi"),
    ).toBeUndefined();
  });

  test("keeps utility nodes without credentials", () => {
    const nodes = searchNodes(["set", "if"], 10);
    const supported = new Set<string>();
    const { remaining } = filterNodesByIntegrationSupport(nodes, supported);

    // Utility nodes (no creds) should always remain
    const utilityNodes = remaining.filter((r) => !r.node.credentials?.length);
    expect(utilityNodes.length).toBeGreaterThan(0);
  });

  test("openAiApi credential is recognized by bridge map", () => {
    // Simulates what checkCredentialTypes does in the cloud bridge
    const API_KEY_CRED_TYPES = new Set(["openAiApi"]);
    const OAUTH_PREFIXES = [
      "gmail",
      "google",
      "gSuite",
      "youTube",
      "slack",
      "github",
      "linear",
      "notion",
      "twitter",
    ];

    const isSupported = (credType: string) =>
      API_KEY_CRED_TYPES.has(credType) ||
      OAUTH_PREFIXES.some((p) => credType.startsWith(p));

    // These should all be supported
    expect(isSupported("openAiApi")).toBe(true);
    expect(isSupported("gmailOAuth2Api")).toBe(true);
    expect(isSupported("slackOAuth2Api")).toBe(true);

    // This should NOT be supported
    expect(isSupported("hubspotOAuth2Api")).toBe(false);
  });
});

describe("simplifyNodeForLLM", () => {
  test("strips notice and hidden properties", () => {
    const openai = getNodeDefinition("@n8n/n8n-nodes-langchain.openAi");
    expect(openai).toBeDefined();

    const hasNotice = openai!.properties.some((p) => p.type === "notice");
    const hasHidden = openai!.properties.some((p) => p.type === "hidden");
    expect(hasNotice || hasHidden).toBe(true);

    const simplified = simplifyNodeForLLM(openai!);
    expect(simplified.properties.every((p) => p.type !== "notice")).toBe(true);
    expect(simplified.properties.every((p) => p.type !== "hidden")).toBe(true);
  });

  test("removes routing and displayOptions from properties", () => {
    const openai = getNodeDefinition("@n8n/n8n-nodes-langchain.openAi");
    const simplified = simplifyNodeForLLM(openai!);

    for (const prop of simplified.properties) {
      const raw = prop as unknown as Record<string, unknown>;
      expect(raw.routing).toBeUndefined();
      expect(raw.displayOptions).toBeUndefined();
      expect(raw.typeOptions).toBeUndefined();
      expect(raw.modes).toBeUndefined();
    }
  });

  test("converts resourceLocator to string type", () => {
    const openai = getNodeDefinition("@n8n/n8n-nodes-langchain.openAi");
    const hasResourceLocator = openai!.properties.some(
      (p) => p.type === "resourceLocator",
    );
    expect(hasResourceLocator).toBe(true);

    const simplified = simplifyNodeForLLM(openai!);
    expect(
      simplified.properties.every((p) => p.type !== "resourceLocator"),
    ).toBe(true);
  });

  test("reduces JSON size significantly for complex nodes", () => {
    const openai = getNodeDefinition("@n8n/n8n-nodes-langchain.openAi");
    const simplified = simplifyNodeForLLM(openai!);

    const originalSize = JSON.stringify(openai!.properties).length;
    const simplifiedSize = JSON.stringify(simplified.properties).length;
    expect(simplifiedSize).toBeLessThan(originalSize * 0.7);
  });

  test("preserves required fields and name/type/default", () => {
    const openai = getNodeDefinition("@n8n/n8n-nodes-langchain.openAi");
    const simplified = simplifyNodeForLLM(openai!);

    for (const prop of simplified.properties) {
      expect(prop.name).toBeDefined();
      expect(prop.displayName).toBeDefined();
      expect(prop.type).toBeDefined();
      expect("default" in prop).toBe(true);
    }

    const resource = simplified.properties.find((p) => p.name === "resource");
    expect(resource).toBeDefined();
    expect(resource!.options).toBeDefined();
  });

  test("works on simple nodes without crashing", () => {
    const setNode = getNodeDefinition("n8n-nodes-base.set");
    expect(setNode).toBeDefined();

    const simplified = simplifyNodeForLLM(setNode!);
    expect(simplified.properties.length).toBeGreaterThan(0);
    expect(simplified.name).toBe(setNode!.name);
  });
});
