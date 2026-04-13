import type { Plugin } from "@elizaos/core";
import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Content,
  createMessageMemory,
  LLMMode,
  type LogBodyValue,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import anthropicPlugin from "@elizaos/plugin-anthropic";
import googleGenAIPlugin from "@elizaos/plugin-google-genai";
import groqPlugin from "@elizaos/plugin-groq";
import openaiPlugin from "@elizaos/plugin-openai";
import XAIPlugin from "@elizaos/plugin-xai";
import localAiPlugin from "../../../../plugins/plugin-local-ai/typescript/index.browser";
import localdbPlugin from "../../../../plugins/plugin-localdb/typescript/index.browser";
import { TOWN_AGENTS, type TownAgentDefinition } from "../../shared/agents";
import { DEFAULT_AUDIO_RANGE_TILES } from "../../shared/types";
import elizaTownPlugin from "../plugins/elizaTownPlugin";
import {
  defaultModelSettings,
  type ModelProvider,
  type ModelSettings,
} from "../runtime/modelSettings";
import { getTownContextSnapshot, recordTownMessage } from "./townContext";

type PluginConfigValue = string | number | boolean | null | undefined;

type RuntimeBundle = {
  runtime: AgentRuntime;
  narratorId: UUID;
  roomId: UUID;
  worldId: UUID;
  provider: ModelProvider;
};

const runtimeBundles = new Map<string, RuntimeBundle>();
const sharedWorldId = stringToUuid("ai-town-world");
const narratorId = stringToUuid("ai-town-narrator");

function buildCharacter(profile: TownAgentDefinition): Character {
  const socialContext = buildSocialContext(profile);
  return {
    name: profile.name,
    username: profile.id,
    bio: [profile.description],
    adjectives: ["curious", "friendly", "observant"],
    system: [
      `You are ${profile.name}, the ${profile.role} of Eliza Town.`,
      profile.persona,
      "Speak in one short sentence. Be friendly and keep it simple.",
      "You are playing a social deduction game with night and day phases.",
      "Use the MAFIA_ROLE provider to learn your secret role and objectives.",
      "Use the MAFIA_GAME provider to understand the current phase and actions.",
      "Use the TOWN_OBJECTIVES provider to track and complete your tasks.",
      "Your vision and hearing are limited to your radius. Assume you cannot see or hear beyond it.",
      "Town context:",
      socialContext,
    ].join("\n"),
    settings: {
      AUTONOMY_ENABLED: true,
    },
  };
}

function getProfile(agentId: string): TownAgentDefinition {
  const profile = TOWN_AGENTS.find((agent) => agent.id === agentId);
  if (!profile) {
    throw new Error(`Unknown agent id: ${agentId}`);
  }
  return profile;
}

function buildSocialContext(profile: TownAgentDefinition): string {
  if (profile.relationships.length === 0) {
    return "You keep an open mind and enjoy meeting new people.";
  }
  const idToName = new Map(TOWN_AGENTS.map((agent) => [agent.id, agent.name]));
  return profile.relationships
    .map((relation) => {
      const name = idToName.get(relation.withId) ?? relation.withId;
      return `${name}: ${relation.kind} — ${relation.note}`;
    })
    .join("\n");
}

function buildPlugins(provider: ModelProvider): Plugin[] {
  const basePlugins = [
    normalizePlugin(localdbPlugin),
    normalizePlugin(elizaTownPlugin),
  ];
  switch (provider) {
    case "openai":
      return [...basePlugins, normalizePlugin(openaiPlugin)];
    case "anthropic":
      return [...basePlugins, normalizePlugin(anthropicPlugin)];
    case "google":
      return [...basePlugins, normalizePlugin(googleGenAIPlugin)];
    case "groq":
      return [...basePlugins, normalizePlugin(groqPlugin)];
    case "xai":
      return [...basePlugins, normalizePlugin(XAIPlugin)];
    case "local":
      return [...basePlugins, normalizePlugin(localAiPlugin)];
    default:
      return [...basePlugins, normalizePlugin(openaiPlugin)];
  }
}

function normalizeConfig(
  config?: Record<string, PluginConfigValue>,
): Record<string, string | number | boolean | null> | undefined {
  if (!config) {
    return undefined;
  }
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const key of Object.keys(config)) {
    const value = config[key];
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function normalizePlugin(plugin: unknown): Plugin {
  const pluginObj = plugin as Record<string, unknown>;
  const { config, tests: _tests, ...rest } = pluginObj;
  return {
    ...rest,
    config: normalizeConfig(config as Record<string, PluginConfigValue>),
  } as Plugin;
}

function applySettings(runtime: AgentRuntime, settings: ModelSettings): void {
  runtime.setSetting("LOCALDB_PREFIX", "ai-town");
  runtime.setSetting("CHECK_SHOULD_RESPOND", false);

  if (settings.provider === "openai") {
    runtime.setSetting("OPENAI_ALLOW_BROWSER_API_KEY", "true");
    setOptionalSetting(runtime, "OPENAI_API_KEY", settings.openai.apiKey, true);
    setOptionalSetting(
      runtime,
      "OPENAI_BASE_URL",
      settings.openai.baseUrl ?? "",
    );
    setOptionalSetting(
      runtime,
      "OPENAI_BROWSER_BASE_URL",
      settings.openai.baseUrl ?? "",
    );
    setOptionalSetting(
      runtime,
      "OPENAI_SMALL_MODEL",
      settings.openai.smallModel,
    );
    setOptionalSetting(
      runtime,
      "OPENAI_LARGE_MODEL",
      settings.openai.largeModel,
    );
  }

  if (settings.provider === "anthropic") {
    setOptionalSetting(
      runtime,
      "ANTHROPIC_API_KEY",
      settings.anthropic.apiKey,
      true,
    );
    setOptionalSetting(
      runtime,
      "ANTHROPIC_BASE_URL",
      settings.anthropic.baseUrl ?? "",
    );
    setOptionalSetting(
      runtime,
      "ANTHROPIC_BROWSER_BASE_URL",
      settings.anthropic.baseUrl ?? "",
    );
    setOptionalSetting(
      runtime,
      "ANTHROPIC_SMALL_MODEL",
      settings.anthropic.smallModel,
    );
    setOptionalSetting(
      runtime,
      "ANTHROPIC_LARGE_MODEL",
      settings.anthropic.largeModel,
    );
  }

  if (settings.provider === "google") {
    setOptionalSetting(
      runtime,
      "GOOGLE_GENERATIVE_AI_API_KEY",
      settings.google.apiKey,
      true,
    );
    setOptionalSetting(
      runtime,
      "GOOGLE_SMALL_MODEL",
      settings.google.smallModel,
    );
    setOptionalSetting(
      runtime,
      "GOOGLE_LARGE_MODEL",
      settings.google.largeModel,
    );
  }

  if (settings.provider === "groq") {
    runtime.setSetting("GROQ_ALLOW_BROWSER_API_KEY", "true");
    setOptionalSetting(runtime, "GROQ_API_KEY", settings.groq.apiKey, true);
    setOptionalSetting(runtime, "GROQ_BASE_URL", settings.groq.baseUrl ?? "");
    setOptionalSetting(runtime, "GROQ_SMALL_MODEL", settings.groq.smallModel);
    setOptionalSetting(runtime, "GROQ_LARGE_MODEL", settings.groq.largeModel);
  }

  if (settings.provider === "xai") {
    setOptionalSetting(runtime, "XAI_API_KEY", settings.xai.apiKey, true);
    setOptionalSetting(runtime, "XAI_BASE_URL", settings.xai.baseUrl ?? "");
    setOptionalSetting(runtime, "XAI_SMALL_MODEL", settings.xai.smallModel);
    setOptionalSetting(runtime, "XAI_LARGE_MODEL", settings.xai.largeModel);
  }

  if (settings.provider === "local") {
    setOptionalSetting(runtime, "LOCAL_SMALL_MODEL", settings.local.smallModel);
    setOptionalSetting(runtime, "LOCAL_LARGE_MODEL", settings.local.largeModel);
  }
}

function setOptionalSetting(
  runtime: AgentRuntime,
  key: string,
  value: string,
  secret = false,
): void {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    runtime.setSetting(key, trimmed, secret);
  }
}

export async function getRuntimeForAgent(
  agentId: string,
  settings: ModelSettings,
): Promise<RuntimeBundle> {
  const existing = runtimeBundles.get(agentId);
  if (existing) {
    if (existing.provider === settings.provider) {
      applySettings(existing.runtime, settings);
      return existing;
    }
    await existing.runtime.stop();
    runtimeBundles.delete(agentId);
  }

  const profile = getProfile(agentId);
  const runtime = new AgentRuntime({
    character: buildCharacter(profile),
    plugins: buildPlugins(settings.provider),
    actionPlanning: true,
    logLevel: "debug",
    enableAutonomy: true,
    llmMode: LLMMode.SMALL,
  });

  syncAutonomySettings(runtime);
  applySettings(runtime, settings);
  disableEmbeddings(runtime);
  await runtime.initialize();
  disableLogging(runtime);

  const roomId = stringToUuid(`ai-town-room-${agentId}`);
  await runtime.ensureConnection({
    entityId: narratorId,
    roomId,
    worldId: sharedWorldId,
    userName: "Town Narrator",
    source: "ai-town",
    channelId: "ai-town",
    type: ChannelType.GROUP,
  });

  const bundle: RuntimeBundle = {
    runtime,
    narratorId,
    roomId,
    worldId: sharedWorldId,
    provider: settings.provider,
  };

  runtimeBundles.set(agentId, bundle);
  return bundle;
}

export async function requestAgentMoveDecision(
  agentId: string,
  settings: ModelSettings = defaultModelSettings(),
): Promise<boolean> {
  const bundle = await getRuntimeForAgent(agentId, settings);
  const { runtime } = bundle;

  if (!runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const decisionPrompt = [
    "Decide your next move in Eliza Town.",
    "Check TOWN_OBJECTIVES for your assigned tasks and head toward them.",
    "If you are mafia, use the map and objectives to lure isolated targets.",
    "Use the MOVE action with parameters to choose a destination.",
    "You may target an agent, a player, a point of interest, or coordinates.",
    "Choose exactly one MOVE action.",
    "",
    "Action examples (copy the structure):",
    "<response>",
    "  <thought>I'll head to the Town Square to see who's around.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>I'm walking to the Town Square to check the crossroads.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>Town Square</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I'll swing by the Market to listen for rumors.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Heading to the Market to see who's trading today.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>Market</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I want to check the Bridge by the river.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Walking to the Bridge to see who's crossing.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>Bridge</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I'll warm up by the Camp for a moment.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Heading to the Camp to warm up by the fire.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>Camp</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I'll take a look at the Waterfall.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Walking to the Waterfall to check the path.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>Waterfall</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I'll head toward the East Windmill.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Walking to the East Windmill to survey the fields.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>East Windmill</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I'll check on the South Windmill.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Heading to the South Windmill to see the farms.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>South Windmill</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I'll head toward the West Windmill.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Walking to the West Windmill to stay inconspicuous.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>West Windmill</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I should go talk to Maren Sol.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>I'll walk over to Maren Sol for a quick check-in.</text>",
    "  <params>",
    "    <MOVE>",
    "      <target>Maren Sol</target>",
    "    </MOVE>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>I want to move to a specific tile.</thought>",
    "  <actions>REPLY,MOVE</actions>",
    "  <text>Heading to the crossroads.</text>",
    "  <params>",
    "    <MOVE>",
    "      <x>12</x>",
    "      <y>8</y>",
    "    </MOVE>",
    "  </params>",
    "</response>",
  ].join("\n");

  const message = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: bundle.narratorId,
    roomId: bundle.roomId,
    embedding: [],
    content: {
      text: decisionPrompt,
      source: "ai-town",
      channelType: ChannelType.GROUP,
    },
  });

  let responseText = "";
  let responseThought = "";
  const result = await runtime.messageService.handleMessage(
    runtime,
    message,
    (content: Content): Promise<Memory[]> => {
      if (typeof content.text === "string") {
        responseText = content.text;
      }
      if (typeof content.thought === "string") {
        responseThought = content.thought;
      }
      return Promise.resolve([]);
    },
  );
  if (!result.didRespond) {
    return false;
  }
  const responseContent = result.responseContent;
  if (!responseText && typeof responseContent?.text === "string") {
    responseText = responseContent.text;
  }
  if (!responseThought && typeof responseContent?.thought === "string") {
    responseThought = responseContent.thought;
  }
  if (!responseText && responseContent?.actionCallbacks?.text) {
    responseText = responseContent.actionCallbacks.text;
  }
  if (!responseThought && responseContent?.actionCallbacks?.thought) {
    responseThought = responseContent.actionCallbacks.thought;
  }
  if (!responseText.trim()) {
    return result.didRespond;
  }
  const combinedText = buildCombinedText(responseText, responseThought);
  const snapshot = getTownContextSnapshot();
  const nearbyRecipients = snapshot
    ? getNearbyAgentIds(snapshot.state.agents, agentId)
    : [];
  recordTownMessage({
    authorId: agentId,
    text: combinedText,
    participants: [agentId, ...nearbyRecipients],
    createdAt: Date.now(),
  });
  await broadcastMessageToNearbyAgents({
    authorId: agentId,
    text: combinedText,
    settings,
    recipientIds: nearbyRecipients,
  });
  return result.didRespond;
}

export async function requestAgentGameDecision(
  agentId: string,
  settings: ModelSettings = defaultModelSettings(),
): Promise<boolean> {
  const bundle = await getRuntimeForAgent(agentId, settings);
  const { runtime } = bundle;

  if (!runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const decisionPrompt = [
    "Decide your next action in the mafia game.",
    "If you are mafia, prefer targets who are isolated (out of sight/hearing of others).",
    "Check the MAFIA_ROLE and MAFIA_GAME providers for your role and phase.",
    "If you have a valid game action, choose exactly one:",
    "MAFIA_KILL, MAFIA_INVESTIGATE, MAFIA_PROTECT, MAFIA_VOTE.",
    "If it is night and you have a night action, take it.",
    "If it is day and you are alive, choose a suspect and vote.",
    "If no valid action is available, respond with a short sentence and take no action.",
    "",
    "Action examples (copy the structure):",
    "<response>",
    "  <thought>It's night, I'll protect Maren Sol.</thought>",
    "  <actions>MAFIA_PROTECT</actions>",
    "  <text>I'll keep an eye out tonight.</text>",
    "  <params>",
    "    <MAFIA_PROTECT>",
    "      <target>Maren Sol</target>",
    "    </MAFIA_PROTECT>",
    "  </params>",
    "</response>",
    "",
    "<response>",
    "  <thought>Daytime vote: I suspect Juniper Vale.</thought>",
    "  <actions>MAFIA_VOTE</actions>",
    "  <text>I think we should vote out Juniper Vale.</text>",
    "  <params>",
    "    <MAFIA_VOTE>",
    "      <target>Juniper Vale</target>",
    "    </MAFIA_VOTE>",
    "  </params>",
    "</response>",
  ].join("\n");

  const message = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: bundle.narratorId,
    roomId: bundle.roomId,
    embedding: [],
    content: {
      text: decisionPrompt,
      source: "ai-town",
      channelType: ChannelType.GROUP,
    },
  });

  let responseText = "";
  let responseThought = "";
  const result = await runtime.messageService.handleMessage(
    runtime,
    message,
    (content: Content): Promise<Memory[]> => {
      if (typeof content.text === "string") {
        responseText = content.text;
      }
      if (typeof content.thought === "string") {
        responseThought = content.thought;
      }
      return Promise.resolve([]);
    },
  );
  if (!result.didRespond) {
    return false;
  }
  const responseContent = result.responseContent;
  if (!responseText && typeof responseContent?.text === "string") {
    responseText = responseContent.text;
  }
  if (!responseThought && typeof responseContent?.thought === "string") {
    responseThought = responseContent.thought;
  }
  if (!responseText && responseContent?.actionCallbacks?.text) {
    responseText = responseContent.actionCallbacks.text;
  }
  if (!responseThought && responseContent?.actionCallbacks?.thought) {
    responseThought = responseContent.actionCallbacks.thought;
  }
  if (!responseText.trim()) {
    return result.didRespond;
  }
  const combinedText = buildCombinedText(responseText, responseThought);
  const snapshot = getTownContextSnapshot();
  const nearbyRecipients = snapshot
    ? getNearbyAgentIds(snapshot.state.agents, agentId)
    : [];
  recordTownMessage({
    authorId: agentId,
    text: combinedText,
    participants: [agentId, ...nearbyRecipients],
    createdAt: Date.now(),
  });
  await broadcastMessageToNearbyAgents({
    authorId: agentId,
    text: combinedText,
    settings,
    recipientIds: nearbyRecipients,
  });
  return result.didRespond;
}

export async function requestAgentChatDecision(
  agentId: string,
  settings: ModelSettings = defaultModelSettings(),
): Promise<boolean> {
  const bundle = await getRuntimeForAgent(agentId, settings);
  const { runtime } = bundle;

  if (!runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const snapshot = getTownContextSnapshot();
  const selfState = snapshot?.state.agents.find(
    (agent) => agent.id === agentId,
  );
  const statusLine = selfState
    ? `Your status: ${selfState.status}. Current task: ${selfState.lastAction ?? "none"}.`
    : "Your status is unknown.";

  const decisionPrompt = [
    "You are chatting with nearby townsfolk.",
    statusLine,
    "If you are busy (moving, thinking, speaking, or in the middle of a task), you may ignore nearby activity.",
    "If someone nearby spoke recently or you received a notice that someone came near, reply in one short sentence.",
    "Otherwise, say one short sentence to nearby agents.",
    "Use ELIZA_TOWN to see nearby agents and ROOM_MESSAGES for recent chat.",
    "You may use EMOTE to express an emoji instead of speaking.",
  ].join("\n");

  const message = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: bundle.narratorId,
    roomId: bundle.roomId,
    embedding: [],
    content: {
      text: decisionPrompt,
      source: "ai-town",
      channelType: ChannelType.GROUP,
    },
  });

  let responseText = "";
  let responseThought = "";
  const result = await runtime.messageService.handleMessage(
    runtime,
    message,
    (content: Content): Promise<Memory[]> => {
      if (typeof content.text === "string") {
        responseText = content.text;
      }
      if (typeof content.thought === "string") {
        responseThought = content.thought;
      }
      return Promise.resolve([]);
    },
  );

  if (!result.didRespond) {
    return false;
  }

  const responseContent = result.responseContent;
  if (!responseText && typeof responseContent?.text === "string") {
    responseText = responseContent.text;
  }
  if (!responseThought && typeof responseContent?.thought === "string") {
    responseThought = responseContent.thought;
  }
  if (!responseText && responseContent?.actionCallbacks?.text) {
    responseText = responseContent.actionCallbacks.text;
  }
  if (!responseThought && responseContent?.actionCallbacks?.thought) {
    responseThought = responseContent.actionCallbacks.thought;
  }
  if (!responseText.trim()) {
    return result.didRespond;
  }

  const combinedText = buildCombinedText(responseText, responseThought);
  const roomSnapshot = getTownContextSnapshot();
  const nearbyRecipients = roomSnapshot
    ? getNearbyAgentIds(roomSnapshot.state.agents, agentId)
    : [];
  recordTownMessage({
    authorId: agentId,
    text: combinedText,
    participants: [agentId, ...nearbyRecipients],
    createdAt: Date.now(),
  });
  await broadcastMessageToNearbyAgents({
    authorId: agentId,
    text: combinedText,
    settings,
    recipientIds: nearbyRecipients,
  });
  return result.didRespond;
}

export async function generateAgentMessage(
  agentId: string,
  context: string,
  settings: ModelSettings = defaultModelSettings(),
  participants?: string[],
): Promise<string> {
  const bundle = await getRuntimeForAgent(agentId, settings);
  const { runtime } = bundle;

  if (!runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const message = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: bundle.narratorId,
    roomId: bundle.roomId,
    embedding: [],
    content: {
      text: context,
      source: "ai-town",
      channelType: ChannelType.GROUP,
    },
  });

  let responseText = "";
  let responseThought = "";

  const result = await runtime.messageService.handleMessage(
    runtime,
    message,
    (content: Content): Promise<Memory[]> => {
      if (typeof content.text === "string") {
        responseText = content.text;
      }
      if (typeof content.thought === "string") {
        responseThought = content.thought;
      }
      return Promise.resolve([]);
    },
  );

  const responseContent = result.responseContent;
  if (!responseText && typeof responseContent?.text === "string") {
    responseText = responseContent.text;
  }
  if (!responseThought && typeof responseContent?.thought === "string") {
    responseThought = responseContent.thought;
  }
  if (!responseText && responseContent?.actionCallbacks?.text) {
    responseText = responseContent.actionCallbacks.text;
  }
  if (!responseThought && responseContent?.actionCallbacks?.thought) {
    responseThought = responseContent.actionCallbacks.thought;
  }

  const combinedText = buildCombinedText(responseText, responseThought);
  const snapshot = getTownContextSnapshot();
  const nearbyRecipients = snapshot
    ? getNearbyAgentIds(snapshot.state.agents, agentId)
    : [];
  const resolvedParticipants =
    participants && participants.length > 0
      ? participants
      : [agentId, ...nearbyRecipients];
  recordTownMessage({
    authorId: agentId,
    text: combinedText,
    participants: resolvedParticipants,
    createdAt: Date.now(),
  });
  await broadcastMessageToNearbyAgents({
    authorId: agentId,
    text: combinedText,
    settings,
    recipientIds: nearbyRecipients,
  });
  return combinedText;
}

export async function stopTownRuntimes(): Promise<void> {
  const bundles = Array.from(runtimeBundles.values());
  runtimeBundles.clear();
  await Promise.all(bundles.map((bundle) => bundle.runtime.stop()));
}

export function setAutonomyEnabled(enabled: boolean): void {
  for (const bundle of runtimeBundles.values()) {
    bundle.runtime.enableAutonomy = enabled;
    syncAutonomySettings(bundle.runtime);
  }
}

function disableEmbeddings(runtime: AgentRuntime): void {
  const originalGetModel = runtime.getModel.bind(runtime);
  runtime.getModel = (modelType) => {
    if (modelType === ModelType.TEXT_EMBEDDING) {
      return undefined;
    }
    return originalGetModel(modelType);
  };
  runtime.addEmbeddingToMemory = (memory: Memory): Promise<Memory> =>
    Promise.resolve(memory);
  runtime.queueEmbeddingGeneration = (_memory: Memory): Promise<void> =>
    Promise.resolve();
}

function syncAutonomySettings(runtime: AgentRuntime): void {
  const setting = runtime.getSetting("AUTONOMY_ENABLED");
  const enabled =
    runtime.enableAutonomy || setting === true || setting === "true";
  runtime.enableAutonomy = enabled;
  runtime.setSetting("AUTONOMY_ENABLED", enabled);
}

function buildCombinedText(
  responseText: string,
  responseThought: string,
): string {
  const text = responseText.trim();
  const thought = responseThought.trim();
  if (!text) {
    throw new Error("Agent message generation failed: empty response.");
  }
  return thought ? `<thought>${thought}</thought>\n${text}` : text;
}

function getNearbyAgentIds(
  agents: Array<{
    id: string;
    position: { x: number; y: number };
    audioRangeTiles: number;
  }>,
  authorId: string,
): string[] {
  const author = agents.find((agent) => agent.id === authorId);
  if (!author) {
    return [];
  }
  const recipients: string[] = [];
  for (const agent of agents) {
    if (agent.id === authorId) {
      continue;
    }
    const dx = Math.abs(agent.position.x - author.position.x);
    const dy = Math.abs(agent.position.y - author.position.y);
    const range = agent.audioRangeTiles ?? DEFAULT_AUDIO_RANGE_TILES;
    if (Math.max(dx, dy) <= range) {
      recipients.push(agent.id);
    }
  }
  return recipients;
}

export async function sendProximityNotice(
  recipientId: string,
  nearbyName: string,
  settings: ModelSettings = defaultModelSettings(),
): Promise<void> {
  const bundle = await getRuntimeForAgent(recipientId, settings);
  const text = `${nearbyName} has come near.`;
  const memory = createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: bundle.narratorId,
    agentId: bundle.runtime.agentId,
    roomId: bundle.roomId,
    content: {
      text,
      source: "ai-town",
      channelType: ChannelType.GROUP,
    },
    embedding: [],
  });
  await bundle.runtime.createMemory(memory, "messages");
}

async function broadcastMessageToNearbyAgents(params: {
  authorId: string;
  text: string;
  settings: ModelSettings;
  recipientIds?: string[];
}): Promise<void> {
  const snapshot = getTownContextSnapshot();
  if (!snapshot) {
    return;
  }
  const recipients =
    params.recipientIds ??
    getNearbyAgentIds(snapshot.state.agents, params.authorId);

  if (recipients.length === 0) {
    return;
  }

  const authorProfile = TOWN_AGENTS.find(
    (agent) => agent.id === params.authorId,
  );
  const authorName = authorProfile?.name ?? params.authorId;
  const authorEntityId = stringToUuid(params.authorId);

  await Promise.all(
    recipients.map(async (recipientId) => {
      const bundle = await getRuntimeForAgent(recipientId, params.settings);
      // Ensure the author entity exists in the recipient's runtime
      await bundle.runtime.ensureConnection({
        entityId: authorEntityId,
        roomId: bundle.roomId,
        worldId: bundle.worldId,
        userName: authorName,
        source: "ai-town",
        channelId: "ai-town",
        type: ChannelType.GROUP,
      });
      const memory = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: authorEntityId,
        agentId: bundle.runtime.agentId,
        roomId: bundle.roomId,
        content: {
          text: params.text,
          source: "ai-town",
          channelType: ChannelType.GROUP,
        },
        embedding: [],
      });
      await bundle.runtime.createMemory(memory, "messages");
    }),
  );
}

type RuntimeLogParams = {
  body: Record<string, LogBodyValue>;
  entityId: UUID;
  roomId: UUID;
  type: string;
};

function disableLogging(runtime: AgentRuntime): void {
  if (runtime.adapter) {
    runtime.adapter.log = (_params: RuntimeLogParams): Promise<void> =>
      Promise.resolve();
  }
}
