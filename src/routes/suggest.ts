import { desc, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { isHex, sha256, toHex } from "viem";
import {
  type IAgentRuntime,
  ModelType,
  type Route,
  logger,
} from "@elizaos/core";
import { schema } from "@elizaos/plugin-sql";
import { modules } from "../actions/modules";
import { LEVVA_SERVICE } from "../constants/enum";
import { suggestTypeTemplate } from "../templates/generate";
import { CacheEntry } from "../types/core";
import { ILevvaService } from "../types/service";
import { getDb, getLevvaUser } from "../util/db";

interface MessageEntry {
  authorId: string;
  rawMessage: {
    text?: string;
    message?: string;
    actions: string[];
    thought: string;
    metadata: Record<string, any>;
  };
}

interface Suggestions {
  label: string;
  text: string;
}

const getChainId = (message?: MessageEntry): number | undefined => {
  const value = message?.rawMessage.metadata?.chainId;

  if (typeof value === "number") {
    return value;
  }
};

async function handler(req: Request, res: Response, runtime: IAgentRuntime) {
  const { address, chainId: _chainId, channelId } = req.query;
  const service = runtime.getService<ILevvaService>(LEVVA_SERVICE.LEVVA_COMMON);

  try {
    if (!isHex(address)) {
      throw new Error("Invalid address");
    }

    if (!channelId) {
      throw new Error("Channel ID is required");
    }

    const user = (await getLevvaUser(runtime, { address }))[0];

    if (!user) {
      throw new Error("User not found");
    }

    if (!_chainId) {
      throw new Error("Chain ID is required");
    }

    const chainId = Number(_chainId);

    if (!Number.isFinite(chainId)) {
      throw new Error("Invalid chain ID");
    }

    const db = getDb(runtime);

    const messages = (await db
      .select()
      .from(schema.messageTable)
      .where(eq(schema.messageTable.channelId, channelId))
      .orderBy(desc(schema.messageTable.createdAt))
      .limit(10)) as MessageEntry[];

    const needsSuggest = !messages.length || messages[0].authorId !== user.id;

    if (!needsSuggest) {
      res.status(200).json({
        success: true,
        suggestions: [],
      });

      return;
    }

    const recentMessages: (MessageEntry["rawMessage"] & {
      isAgent: boolean;
    })[] = [];

    let actionLookup: string | undefined;

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      const isAgent = message.authorId !== user.id;

      if (!actionLookup) {
        actionLookup = message.rawMessage.actions[0];
      }

      const messageChainId = isAgent
        ? getChainId(messages[i + 1]) // or should lookup while chainid is not found or hit end of array?
        : getChainId(message);

      if (messageChainId && messageChainId !== chainId) {
        continue;
      }

      const raw = message.rawMessage;
      recentMessages.push({ ...raw, isAgent });
    }

    const suggestions = modules.find(
      (m) => m.action.name === actionLookup
    )?.suggest;

    const conversation = recentMessages
      .map((item) => {
        return `${item.isAgent ? "Agent: " : "User: "} ${item.text ?? item.message}`;
      })
      .reverse()
      .join("\n");

    const conversationHash = sha256(toHex(conversation));

    const cached = await runtime.getCache<CacheEntry<Suggestions[]>>(
      `suggestions:${user.address}:${chainId}`
    );

    if (cached?.hash === conversationHash) {
      res.status(200).json({
        success: true,
        suggestions: cached.value,
      });

      return;
    }

    const defSuggest = {
      name: "default",
      description:
        "in case the rest suggestion types do not fit, suggest conversation topics based on agent's capabilities",
    };

    // todo register suggest types corresponding to actions
    // todo improve prompt to determine suggest type
    const gen = await runtime.useModel(ModelType.OBJECT_LARGE, {
      prompt: suggestTypeTemplate([
        defSuggest,
        ...(suggestions?.map(({ name, description }) => ({
          name,
          description,
        })) ?? []),
      ])
        .replace("{{userData}}", JSON.stringify(user))
        .replace("{{conversation}}", conversation),
    });

    const type = gen.type;
    const suggest = suggestions?.find((s) => s.name === type);

    let result: { suggestions: Suggestions[] } | undefined;

    if (suggest) {
      const model = suggest.model ?? ModelType.OBJECT_SMALL;

      const prompt = await suggest.getPrompt(runtime, {
        address,
        chainId,
        conversation,
        decision: gen,
      });

      result = await runtime.useModel(model, {
        prompt,
      });
    } else {
      result = await runtime.useModel(ModelType.OBJECT_SMALL, {
        prompt: `<task>
Generate suggestions for user based on the conversation leading to the following action types
</task>
<decision>
${JSON.stringify(gen)}
</decision>
<conversation>
${conversation}
</conversation>
<actionTypes>
- Analyze portfolio
- Suggest strategy
- Swap tokens
- Crypto news
</actionTypes>
<instructions>
Generate 4 suggestions for chat with agent
</instructions>
<keys>
- "suggestions" should be an array of objects with the following keys:
  - "label"
  - "text"
</keys>
<output>
Respond using JSON format like this:
{
  "suggestions": [
    {
      "label": "What's new?",
      "text": "What's the latest crypto news?",
    }, {
      "label": "Find preferred stragegy",
      "text": "Can you suggest an optimal strategy for me?",
    }, {
      "label": "Exchange tokens",
      "text": "I want to swap tokens, please help",
    }, {
      "label": "Analyze my wallet",
      "text": "Please, tell me about my portfolio",
    }
  ]
}

Your response should include the valid JSON block and nothing else.
</output>`,
      });
    }

    await runtime.setCache(`suggestions:${user.address}:${chainId}`, {
      hash: conversationHash,
      value: result?.suggestions ?? [],
    });

    res.status(200).json({
      success: true,
      suggestions: result?.suggestions ?? [],
    });
  } catch (error) {
    logger.error(error);

    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

const suggestRoute: Route = {
  name: "suggest",
  path: "/suggest",
  type: "GET",
  handler,
};

export default suggestRoute;
