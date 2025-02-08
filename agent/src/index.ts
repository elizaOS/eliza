import { PGLiteDatabaseAdapter } from "@elizaos/adapter-pglite";
import { PostgresDatabaseAdapter } from "@elizaos/adapter-postgres";
import { QdrantDatabaseAdapter } from "@elizaos/adapter-qdrant";
import { RedisClient } from "@elizaos/adapter-redis";
import { SqliteDatabaseAdapter } from "@elizaos/adapter-sqlite";
import { SupabaseDatabaseAdapter } from "@elizaos/adapter-supabase";
import { AutoClientInterface } from "@elizaos/client-auto";
import { DiscordClientInterface } from "@elizaos/client-discord";
import { InstagramClientInterface } from "@elizaos/client-instagram";
import { LensAgentClient } from "@elizaos/client-lens";
import { SlackClientInterface } from "@elizaos/client-slack";
import { TelegramClientInterface } from "@elizaos/client-telegram";
import { TelegramAccountClientInterface } from "@elizaos/client-telegram-account";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import { AlexaClientInterface } from "@elizaos/client-alexa";
import { MongoDBDatabaseAdapter } from "@elizaos/adapter-mongodb";
import { DevaClientInterface } from "@elizaos/client-deva";

import { FarcasterClientInterface } from "@elizaos/client-farcaster";
import { OmniflixPlugin } from "@elizaos/plugin-omniflix";
import { JeeterClientInterface } from "@elizaos/client-simsai";
import { XmtpClientInterface } from "@elizaos/client-xmtp";
import { DirectClient } from "@elizaos/client-direct";
import { agentKitPlugin } from "@elizaos/plugin-agentkit";
import { gelatoPlugin } from "@elizaos/plugin-gelato";
import { PrimusAdapter } from "@elizaos/plugin-primus";
import { lightningPlugin } from "@elizaos/plugin-lightning";
import { elizaCodeinPlugin, onchainJson } from "@elizaos/plugin-iq6900";
import { dcapPlugin } from "@elizaos/plugin-dcap";
import {
    AgentRuntime,
    CacheManager,
    CacheStore,
    type Character,
    type Client,
    Clients,
    DbCacheAdapter,
    defaultCharacter,
    elizaLogger,
    FsCacheAdapter,
    type IAgentRuntime,
    type ICacheManager,
    type IDatabaseAdapter,
    type IDatabaseCacheAdapter,
    type TypeDatabaseAdapter,
    ModelProviderName,
    parseBooleanFromText,
    settings,
    stringToUuid,
    validateCharacterConfig,
} from "@elizaos/core";
import { zgPlugin } from "@elizaos/plugin-0g";
import { footballPlugin } from "@elizaos/plugin-football";

import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { normalizeCharacter } from "@elizaos/plugin-di";
import createGoatPlugin from "@elizaos/plugin-goat";
import createZilliqaPlugin from "@elizaos/plugin-zilliqa";

// import { intifacePlugin } from "@elizaos/plugin-intiface";
import { ThreeDGenerationPlugin } from "@elizaos/plugin-3d-generation";
import { abstractPlugin } from "@elizaos/plugin-abstract";
import { akashPlugin } from "@elizaos/plugin-akash";
import { alloraPlugin } from "@elizaos/plugin-allora";
import { aptosPlugin } from "@elizaos/plugin-aptos";
import { artheraPlugin } from "@elizaos/plugin-arthera";
import { autonomePlugin } from "@elizaos/plugin-autonome";
import { availPlugin } from "@elizaos/plugin-avail";
import { avalanchePlugin } from "@elizaos/plugin-avalanche";
import { b2Plugin } from "@elizaos/plugin-b2";
import { binancePlugin } from "@elizaos/plugin-binance";
import { birdeyePlugin } from "@elizaos/plugin-birdeye";
import { bittensorPlugin } from "@elizaos/plugin-bittensor";
import { bnbPlugin } from "@elizaos/plugin-bnb";
import {
    advancedTradePlugin,
    coinbaseCommercePlugin,
    coinbaseMassPaymentsPlugin,
    tokenContractPlugin,
    tradePlugin,
    webhookPlugin,
} from "@elizaos/plugin-coinbase";
import { coingeckoPlugin } from "@elizaos/plugin-coingecko";
import { coinmarketcapPlugin } from "@elizaos/plugin-coinmarketcap";
import { confluxPlugin } from "@elizaos/plugin-conflux";
import { createCosmosPlugin } from "@elizaos/plugin-cosmos";
import { cronosZkEVMPlugin } from "@elizaos/plugin-cronoszkevm";
import { deskExchangePlugin } from "@elizaos/plugin-desk-exchange";
import { evmPlugin } from "@elizaos/plugin-evm";
import { edwinPlugin } from "@elizaos/plugin-edwin";
import { flowPlugin } from "@elizaos/plugin-flow";
import { fuelPlugin } from "@elizaos/plugin-fuel";
import { genLayerPlugin } from "@elizaos/plugin-genlayer";
import { gitcoinPassportPlugin } from "@elizaos/plugin-gitcoin-passport";
import { initiaPlugin } from "@elizaos/plugin-initia";
import { imageGenerationPlugin } from "@elizaos/plugin-image-generation";
import { lensPlugin } from "@elizaos/plugin-lens-network";
import { litPlugin } from "@elizaos/plugin-lit";
import { mindNetworkPlugin } from "@elizaos/plugin-mind-network";
import { multiversxPlugin } from "@elizaos/plugin-multiversx";
import { nearPlugin } from "@elizaos/plugin-near";
import createNFTCollectionsPlugin from "@elizaos/plugin-nft-collections";
import { nftGenerationPlugin } from "@elizaos/plugin-nft-generation";
import { createNodePlugin } from "@elizaos/plugin-node";
import { obsidianPlugin } from "@elizaos/plugin-obsidian";
import { OpacityAdapter } from "@elizaos/plugin-opacity";
import { openWeatherPlugin } from "@elizaos/plugin-open-weather";
import { quaiPlugin } from "@elizaos/plugin-quai";
import { sgxPlugin } from "@elizaos/plugin-sgx";
import { solanaPlugin } from "@elizaos/plugin-solana";
import { solanaPluginV2 } from "@elizaos/plugin-solana-v2";
import { solanaAgentkitPlugin } from "@elizaos/plugin-solana-agent-kit";
import { squidRouterPlugin } from "@elizaos/plugin-squid-router";
import { stargazePlugin } from "@elizaos/plugin-stargaze";
import { storyPlugin } from "@elizaos/plugin-story";
import { suiPlugin } from "@elizaos/plugin-sui";
import { TEEMode, teePlugin } from "@elizaos/plugin-tee";
import { teeLogPlugin } from "@elizaos/plugin-tee-log";
import { teeMarlinPlugin } from "@elizaos/plugin-tee-marlin";
import { verifiableLogPlugin } from "@elizaos/plugin-tee-verifiable-log";
import { tonPlugin } from "@elizaos/plugin-ton";
import { webSearchPlugin } from "@elizaos/plugin-web-search";
import { dkgPlugin } from "@elizaos/plugin-dkg";
import { injectivePlugin } from "@elizaos/plugin-injective";
import { giphyPlugin } from "@elizaos/plugin-giphy";
import { letzAIPlugin } from "@elizaos/plugin-letzai";
import { thirdwebPlugin } from "@elizaos/plugin-thirdweb";
import { hyperliquidPlugin } from "@elizaos/plugin-hyperliquid";
import { moralisPlugin } from "@elizaos/plugin-moralis";
import { echoChambersPlugin } from "@elizaos/plugin-echochambers";
import { dexScreenerPlugin } from "@elizaos/plugin-dexscreener";
import { pythDataPlugin } from "@elizaos/plugin-pyth-data";
import { openaiPlugin } from "@elizaos/plugin-openai";
import nitroPlugin from "@elizaos/plugin-router-nitro";
import { devinPlugin } from "@elizaos/plugin-devin";
import { zksyncEraPlugin } from "@elizaos/plugin-zksync-era";
import { chainbasePlugin } from "@elizaos/plugin-chainbase";
import { holdstationPlugin } from "@elizaos/plugin-holdstation";
import { nvidiaNimPlugin } from "@elizaos/plugin-nvidia-nim";
import { zxPlugin } from "@elizaos/plugin-0x";
import { hyperbolicPlugin } from "@elizaos/plugin-hyperbolic";
import Database from "better-sqlite3";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import yargs from "yargs";
import { emailPlugin } from "@elizaos/plugin-email";
import { emailAutomationPlugin } from "@elizaos/plugin-email-automation";
import { seiPlugin } from "@elizaos/plugin-sei";
import { sunoPlugin } from "@elizaos/plugin-suno";
import { udioPlugin } from "@elizaos/plugin-udio";
import { imgflipPlugin } from "@elizaos/plugin-imgflip";
import { ethstoragePlugin } from "@elizaos/plugin-ethstorage";
import { zerionPlugin } from "@elizaos/plugin-zerion";
import { minaPlugin } from "@elizaos/plugin-mina";
import { ankrPlugin } from "@elizaos/plugin-ankr";
import { formPlugin } from "@elizaos/plugin-form";
import { MongoClient } from "mongodb";
import { quickIntelPlugin } from "@elizaos/plugin-quick-intel";

import { trikonPlugin } from "@elizaos/plugin-trikon";
import arbitragePlugin from "@elizaos/plugin-arbitrage";
const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

export const wait = (minTime = 1000, maxTime = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

const logFetch = async (url: string, options: any) => {
    elizaLogger.debug(`Fetching ${url}`);
    // Disabled to avoid disclosure of sensitive information such as API keys
    // elizaLogger.debug(JSON.stringify(options, null, 2));
    return fetch(url, options);
};

export function parseArguments(): {
    character?: string;
    characters?: string;
} {
    try {
        return yargs(process.argv.slice(3))
            .option("character", {
                type: "string",
                description: "Path to the character JSON file",
            })
            .option("characters", {
                type: "string",
                description:
                    "Comma separated list of paths to character JSON files",
            })
            .parseSync();
    } catch (error) {
        elizaLogger.error("Error parsing arguments:", error);
        return {};
    }
}

function tryLoadFile(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (e) {
        return null;
    }
}
function mergeCharacters(base: Character, child: Character): Character {
    const mergeObjects = (baseObj: any, childObj: any) => {
        const result: any = {};
        const keys = new Set([
            ...Object.keys(baseObj || {}),
            ...Object.keys(childObj || {}),
        ]);
        keys.forEach((key) => {
            if (
                typeof baseObj[key] === "object" &&
                typeof childObj[key] === "object" &&
                !Array.isArray(baseObj[key]) &&
                !Array.isArray(childObj[key])
            ) {
                result[key] = mergeObjects(baseObj[key], childObj[key]);
            } else if (
                Array.isArray(baseObj[key]) ||
                Array.isArray(childObj[key])
            ) {
                result[key] = [
                    ...(baseObj[key] || []),
                    ...(childObj[key] || []),
                ];
            } else {
                result[key] =
                    childObj[key] !== undefined ? childObj[key] : baseObj[key];
            }
        });
        return result;
    };
    return mergeObjects(base, child);
}
function isAllStrings(arr: unknown[]): boolean {
    return Array.isArray(arr) && arr.every((item) => typeof item === "string");
}
export async function loadCharacterFromOnchain(): Promise<Character[]> {
    const jsonText = onchainJson;

    console.log("JSON:", jsonText);
    if (!jsonText) return [];
    const loadedCharacters = [];
    try {
        const character = JSON.parse(jsonText);
        validateCharacterConfig(character);

        // .id isn't really valid
        const characterId = character.id || character.name;
        const characterPrefix = `CHARACTER.${characterId
            .toUpperCase()
            .replace(/ /g, "_")}.`;

        const characterSettings = Object.entries(process.env)
            .filter(([key]) => key.startsWith(characterPrefix))
            .reduce((settings, [key, value]) => {
                const settingKey = key.slice(characterPrefix.length);
                settings[settingKey] = value;
                return settings;
            }, {});

        if (Object.keys(characterSettings).length > 0) {
            character.settings = character.settings || {};
            character.settings.secrets = {
                ...characterSettings,
                ...character.settings.secrets,
            };
        }

        // Handle plugins
        if (isAllStrings(character.plugins)) {
            elizaLogger.info("Plugins are: ", character.plugins);
            const importedPlugins = await Promise.all(
                character.plugins.map(async (plugin) => {
                    const importedPlugin = await import(plugin);
                    return importedPlugin.default;
                })
            );
            character.plugins = importedPlugins;
        }

        loadedCharacters.push(character);
        elizaLogger.info(
            `Successfully loaded character from: ${process.env.IQ_WALLET_ADDRESS}`
        );
        return loadedCharacters;
    } catch (e) {
        elizaLogger.error(
            `Error parsing character from ${process.env.IQ_WALLET_ADDRESS}: ${e}`
        );
        process.exit(1);
    }
}

async function loadCharactersFromUrl(url: string): Promise<Character[]> {
    try {
        const response = await fetch(url);
        const responseJson = await response.json();

        let characters: Character[] = [];
        if (Array.isArray(responseJson)) {
            characters = await Promise.all(
                responseJson.map((character) => jsonToCharacter(url, character))
            );
        } else {
            const character = await jsonToCharacter(url, responseJson);
            characters.push(character);
        }
        return characters;
    } catch (e) {
        elizaLogger.error(`Error loading character(s) from ${url}: ${e}`);
        process.exit(1);
    }
}

async function jsonToCharacter(
    filePath: string,
    character: any
): Promise<Character> {
    validateCharacterConfig(character);

    // .id isn't really valid
    const characterId = character.id || character.name;
    const characterPrefix = `CHARACTER.${characterId
        .toUpperCase()
        .replace(/ /g, "_")}.`;
    const characterSettings = Object.entries(process.env)
        .filter(([key]) => key.startsWith(characterPrefix))
        .reduce((settings, [key, value]) => {
            const settingKey = key.slice(characterPrefix.length);
            return { ...settings, [settingKey]: value };
        }, {});
    if (Object.keys(characterSettings).length > 0) {
        character.settings = character.settings || {};
        character.settings.secrets = {
            ...characterSettings,
            ...character.settings.secrets,
        };
    }
    // Handle plugins
    character.plugins = await handlePluginImporting(character.plugins);
    if (character.extends) {
        elizaLogger.info(
            `Merging  ${character.name} character with parent characters`
        );
        for (const extendPath of character.extends) {
            const baseCharacter = await loadCharacter(
                path.resolve(path.dirname(filePath), extendPath)
            );
            character = mergeCharacters(baseCharacter, character);
            elizaLogger.info(
                `Merged ${character.name} with ${baseCharacter.name}`
            );
        }
    }
    return character;
}

async function loadCharacter(filePath: string): Promise<Character> {
    const content = tryLoadFile(filePath);
    if (!content) {
        throw new Error(`Character file not found: ${filePath}`);
    }
    const character = JSON.parse(content);
    return jsonToCharacter(filePath, character);
}

async function loadCharacterTryPath(characterPath: string): Promise<Character> {
    let content: string | null = null;
    let resolvedPath = "";

    // Try different path resolutions in order
    const pathsToTry = [
        characterPath, // exact path as specified
        path.resolve(process.cwd(), characterPath), // relative to cwd
        path.resolve(process.cwd(), "agent", characterPath), // Add this
        path.resolve(__dirname, characterPath), // relative to current script
        path.resolve(__dirname, "characters", path.basename(characterPath)), // relative to agent/characters
        path.resolve(__dirname, "../characters", path.basename(characterPath)), // relative to characters dir from agent
        path.resolve(
            __dirname,
            "../../characters",
            path.basename(characterPath)
        ), // relative to project root characters dir
    ];

    elizaLogger.info(
        "Trying paths:",
        pathsToTry.map((p) => ({
            path: p,
            exists: fs.existsSync(p),
        }))
    );

    for (const tryPath of pathsToTry) {
        content = tryLoadFile(tryPath);
        if (content !== null) {
            resolvedPath = tryPath;
            break;
        }
    }

    if (content === null) {
        elizaLogger.error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
        elizaLogger.error("Tried the following paths:");
        pathsToTry.forEach((p) => elizaLogger.error(` - ${p}`));
        throw new Error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
    }
    try {
        const character: Character = await loadCharacter(resolvedPath);
        elizaLogger.info(`Successfully loaded character from: ${resolvedPath}`);
        return character;
    } catch (e) {
        elizaLogger.error(`Error parsing character from ${resolvedPath}: ${e}`);
        throw new Error(`Error parsing character from ${resolvedPath}: ${e}`);
    }
}

function commaSeparatedStringToArray(commaSeparated: string): string[] {
    return commaSeparated?.split(",").map((value) => value.trim());
}

async function readCharactersFromStorage(
    characterPaths: string[]
): Promise<string[]> {
    try {
        const uploadDir = path.join(process.cwd(), "data", "characters");
        await fs.promises.mkdir(uploadDir, { recursive: true });
        const fileNames = await fs.promises.readdir(uploadDir);
        fileNames.forEach((fileName) => {
            characterPaths.push(path.join(uploadDir, fileName));
        });
    } catch (err) {
        elizaLogger.error(`Error reading directory: ${err.message}`);
    }

    return characterPaths;
}

export async function loadCharacters(
    charactersArg: string
): Promise<Character[]> {
    let characterPaths = commaSeparatedStringToArray(charactersArg);

    if (process.env.USE_CHARACTER_STORAGE === "true") {
        characterPaths = await readCharactersFromStorage(characterPaths);
    }

    const loadedCharacters: Character[] = [];

    if (characterPaths?.length > 0) {
        for (const characterPath of characterPaths) {
            try {
                const character: Character = await loadCharacterTryPath(
                    characterPath
                );
                loadedCharacters.push(character);
            } catch (e) {
                process.exit(1);
            }
        }
    }

    if (hasValidRemoteUrls()) {
        elizaLogger.info("Loading characters from remote URLs");
        const characterUrls = commaSeparatedStringToArray(
            process.env.REMOTE_CHARACTER_URLS
        );
        for (const characterUrl of characterUrls) {
            const characters = await loadCharactersFromUrl(characterUrl);
            loadedCharacters.push(...characters);
        }
    }

    if (loadedCharacters.length === 0) {
        elizaLogger.info("No characters found, using default character");
        loadedCharacters.push(defaultCharacter);
    }

    return loadedCharacters;
}

async function handlePluginImporting(plugins: string[]) {
    if (plugins.length > 0) {
        elizaLogger.info("Plugins are: ", plugins);
        const importedPlugins = await Promise.all(
            plugins.map(async (plugin) => {
                try {
                    const importedPlugin = await import(plugin);
                    const functionName =
                        plugin
                            .replace("@elizaos/plugin-", "")
                            .replace(/-./g, (x) => x[1].toUpperCase()) +
                        "Plugin"; // Assumes plugin function is camelCased with Plugin suffix
                    return (
                        importedPlugin.default || importedPlugin[functionName]
                    );
                } catch (importError) {
                    elizaLogger.error(
                        `Failed to import plugin: ${plugin}`,
                        importError
                    );
                    return []; // Return null for failed imports
                }
            })
        );
        return importedPlugins;
    } else {
        return [];
    }
}

export function getTokenForProvider(
    provider: ModelProviderName,
    character: Character
): string | undefined {
    switch (provider) {
        // no key needed for llama_local, ollama, lmstudio, gaianet or bedrock
        case ModelProviderName.LLAMALOCAL:
            return "";
        case ModelProviderName.OLLAMA:
            return "";
        case ModelProviderName.LMSTUDIO:
            return "";
        case ModelProviderName.GAIANET:
            return "";
        case ModelProviderName.BEDROCK:
            return "";
        case ModelProviderName.OPENAI:
            return (
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.ETERNALAI:
            return (
                character.settings?.secrets?.ETERNALAI_API_KEY ||
                settings.ETERNALAI_API_KEY
            );
        case ModelProviderName.NINETEEN_AI:
            return (
                character.settings?.secrets?.NINETEEN_AI_API_KEY ||
                settings.NINETEEN_AI_API_KEY
            );
        case ModelProviderName.LLAMACLOUD:
        case ModelProviderName.TOGETHER:
            return (
                character.settings?.secrets?.LLAMACLOUD_API_KEY ||
                settings.LLAMACLOUD_API_KEY ||
                character.settings?.secrets?.TOGETHER_API_KEY ||
                settings.TOGETHER_API_KEY ||
                character.settings?.secrets?.OPENAI_API_KEY ||
                settings.OPENAI_API_KEY
            );
        case ModelProviderName.CLAUDE_VERTEX:
        case ModelProviderName.ANTHROPIC:
            return (
                character.settings?.secrets?.ANTHROPIC_API_KEY ||
                character.settings?.secrets?.CLAUDE_API_KEY ||
                settings.ANTHROPIC_API_KEY ||
                settings.CLAUDE_API_KEY
            );
        case ModelProviderName.REDPILL:
            return (
                character.settings?.secrets?.REDPILL_API_KEY ||
                settings.REDPILL_API_KEY
            );
        case ModelProviderName.OPENROUTER:
            return (
                character.settings?.secrets?.OPENROUTER_API_KEY ||
                settings.OPENROUTER_API_KEY
            );
        case ModelProviderName.GROK:
            return (
                character.settings?.secrets?.GROK_API_KEY ||
                settings.GROK_API_KEY
            );
        case ModelProviderName.HEURIST:
            return (
                character.settings?.secrets?.HEURIST_API_KEY ||
                settings.HEURIST_API_KEY
            );
        case ModelProviderName.GROQ:
            return (
                character.settings?.secrets?.GROQ_API_KEY ||
                settings.GROQ_API_KEY
            );
        case ModelProviderName.GALADRIEL:
            return (
                character.settings?.secrets?.GALADRIEL_API_KEY ||
                settings.GALADRIEL_API_KEY
            );
        case ModelProviderName.FAL:
            return (
                character.settings?.secrets?.FAL_API_KEY || settings.FAL_API_KEY
            );
        case ModelProviderName.ALI_BAILIAN:
            return (
                character.settings?.secrets?.ALI_BAILIAN_API_KEY ||
                settings.ALI_BAILIAN_API_KEY
            );
        case ModelProviderName.VOLENGINE:
            return (
                character.settings?.secrets?.VOLENGINE_API_KEY ||
                settings.VOLENGINE_API_KEY
            );
        case ModelProviderName.NANOGPT:
            return (
                character.settings?.secrets?.NANOGPT_API_KEY ||
                settings.NANOGPT_API_KEY
            );
        case ModelProviderName.HYPERBOLIC:
            return (
                character.settings?.secrets?.HYPERBOLIC_API_KEY ||
                settings.HYPERBOLIC_API_KEY
            );

        case ModelProviderName.VENICE:
            return (
                character.settings?.secrets?.VENICE_API_KEY ||
                settings.VENICE_API_KEY
            );
        case ModelProviderName.ATOMA:
            return (
                character.settings?.secrets?.ATOMASDK_BEARER_AUTH ||
                settings.ATOMASDK_BEARER_AUTH
            );
        case ModelProviderName.NVIDIA:
            return (
                character.settings?.secrets?.NVIDIA_API_KEY ||
                settings.NVIDIA_API_KEY
            );
        case ModelProviderName.AKASH_CHAT_API:
            return (
                character.settings?.secrets?.AKASH_CHAT_API_KEY ||
                settings.AKASH_CHAT_API_KEY
            );
        case ModelProviderName.GOOGLE:
            return (
                character.settings?.secrets?.GOOGLE_GENERATIVE_AI_API_KEY ||
                settings.GOOGLE_GENERATIVE_AI_API_KEY
            );
        case ModelProviderName.MISTRAL:
            return (
                character.settings?.secrets?.MISTRAL_API_KEY ||
                settings.MISTRAL_API_KEY
            );
        case ModelProviderName.LETZAI:
            return (
                character.settings?.secrets?.LETZAI_API_KEY ||
                settings.LETZAI_API_KEY
            );
        case ModelProviderName.INFERA:
            return (
                character.settings?.secrets?.INFERA_API_KEY ||
                settings.INFERA_API_KEY
            );
        case ModelProviderName.DEEPSEEK:
            return (
                character.settings?.secrets?.DEEPSEEK_API_KEY ||
                settings.DEEPSEEK_API_KEY
            );
        case ModelProviderName.LIVEPEER:
            return (
                character.settings?.secrets?.LIVEPEER_GATEWAY_URL ||
                settings.LIVEPEER_GATEWAY_URL
            );
        default:
            const errorMessage = `Failed to get token - unsupported model provider: ${provider}`;
            elizaLogger.error(errorMessage);
            throw new Error(errorMessage);
    }
}

function initializeDatabase(dataDir: string) {
    if (process.env.MONGODB_CONNECTION_STRING) {
        elizaLogger.log("Initializing database on MongoDB Atlas");
        const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING, {
            maxPoolSize: 100,
            minPoolSize: 5,
            maxIdleTimeMS: 60000,
            connectTimeoutMS: 10000,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            compressors: ["zlib"],
            retryWrites: true,
            retryReads: true,
        });

        const dbName = process.env.MONGODB_DATABASE || "elizaAgent";
        const db = new MongoDBDatabaseAdapter(client, dbName);

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success("Successfully connected to MongoDB Atlas");
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to MongoDB Atlas:", error);
                throw error; // Re-throw to handle it in the calling code
            });

        return db;
    } else if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
        elizaLogger.info("Initializing Supabase connection...");
        const db = new SupabaseDatabaseAdapter(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY
        );

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to Supabase database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to Supabase:", error);
            });

        return db;
    } else if (process.env.POSTGRES_URL) {
        elizaLogger.info("Initializing PostgreSQL connection...");
        const db = new PostgresDatabaseAdapter({
            connectionString: process.env.POSTGRES_URL,
            parseInputs: true,
        });

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to PostgreSQL database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to PostgreSQL:", error);
            });

        return db;
    } else if (process.env.PGLITE_DATA_DIR) {
        elizaLogger.info("Initializing PgLite adapter...");
        // `dataDir: memory://` for in memory pg
        const db = new PGLiteDatabaseAdapter({
            dataDir: process.env.PGLITE_DATA_DIR,
        });
        return db;
    } else if (
        process.env.QDRANT_URL &&
        process.env.QDRANT_KEY &&
        process.env.QDRANT_PORT &&
        process.env.QDRANT_VECTOR_SIZE
    ) {
        elizaLogger.info("Initializing Qdrant adapter...");
        const db = new QdrantDatabaseAdapter(
            process.env.QDRANT_URL,
            process.env.QDRANT_KEY,
            Number(process.env.QDRANT_PORT),
            Number(process.env.QDRANT_VECTOR_SIZE)
        );
        return db;
    } else {
        const filePath =
            process.env.SQLITE_FILE ?? path.resolve(dataDir, "db.sqlite");
        elizaLogger.info(`Initializing SQLite database at ${filePath}...`);
        const db = new SqliteDatabaseAdapter(new Database(filePath));

        // Test the connection
        db.init()
            .then(() => {
                elizaLogger.success(
                    "Successfully connected to SQLite database"
                );
            })
            .catch((error) => {
                elizaLogger.error("Failed to connect to SQLite:", error);
            });

        return db;
    }
}

// also adds plugins from character file into the runtime
export async function initializeClients(
    character: Character,
    runtime: IAgentRuntime
) {
    // each client can only register once
    // and if we want two we can explicitly support it
    const clients: Record<string, any> = {};
    const clientTypes: string[] =
        character.clients?.map((str) => str.toLowerCase()) || [];
    elizaLogger.log("initializeClients", clientTypes, "for", character.name);

    // Start Auto Client if "auto" detected as a configured client
    if (clientTypes.includes(Clients.AUTO)) {
        const autoClient = await AutoClientInterface.start(runtime);
        if (autoClient) clients.auto = autoClient;
    }

    if (clientTypes.includes(Clients.XMTP)) {
        const xmtpClient = await XmtpClientInterface.start(runtime);
        if (xmtpClient) clients.xmtp = xmtpClient;
    }

    if (clientTypes.includes(Clients.DISCORD)) {
        const discordClient = await DiscordClientInterface.start(runtime);
        if (discordClient) clients.discord = discordClient;
    }

    if (clientTypes.includes(Clients.TELEGRAM)) {
        const telegramClient = await TelegramClientInterface.start(runtime);
        if (telegramClient) clients.telegram = telegramClient;
    }

    if (clientTypes.includes(Clients.TELEGRAM_ACCOUNT)) {
        const telegramAccountClient =
            await TelegramAccountClientInterface.start(runtime);
        if (telegramAccountClient)
            clients.telegram_account = telegramAccountClient;
    }

    if (clientTypes.includes(Clients.TWITTER)) {
        const twitterClient = await TwitterClientInterface.start(runtime);
        if (twitterClient) {
            clients.twitter = twitterClient;
        }
    }

    if (clientTypes.includes(Clients.ALEXA)) {
        const alexaClient = await AlexaClientInterface.start(runtime);
        if (alexaClient) {
            clients.alexa = alexaClient;
        }
    }

    if (clientTypes.includes(Clients.INSTAGRAM)) {
        const instagramClient = await InstagramClientInterface.start(runtime);
        if (instagramClient) {
            clients.instagram = instagramClient;
        }
    }

    if (clientTypes.includes(Clients.FARCASTER)) {
        const farcasterClient = await FarcasterClientInterface.start(runtime);
        if (farcasterClient) {
            clients.farcaster = farcasterClient;
        }
    }

    if (clientTypes.includes("lens")) {
        const lensClient = new LensAgentClient(runtime);
        lensClient.start();
        clients.lens = lensClient;
    }

    if (clientTypes.includes(Clients.SIMSAI)) {
        const simsaiClient = await JeeterClientInterface.start(runtime);
        if (simsaiClient) clients.simsai = simsaiClient;
    }

    elizaLogger.log("client keys", Object.keys(clients));

    if (clientTypes.includes("deva")) {
        if (clientTypes.includes("deva")) {
            const devaClient = await DevaClientInterface.start(runtime);
            if (devaClient) clients.deva = devaClient;
        }
    }

    if (clientTypes.includes("slack")) {
        const slackClient = await SlackClientInterface.start(runtime);
        if (slackClient) clients.slack = slackClient; // Use object property instead of push
    }

    function determineClientType(client: Client): string {
        // Check if client has a direct type identifier
        if ("type" in client) {
            return (client as any).type;
        }

        // Check constructor name
        const constructorName = client.constructor?.name;
        if (constructorName && !constructorName.includes("Object")) {
            return constructorName.toLowerCase().replace("client", "");
        }

        // Fallback: Generate a unique identifier
        return `client_${Date.now()}`;
    }

    if (character.plugins?.length > 0) {
        for (const plugin of character.plugins) {
            if (plugin.clients) {
                for (const client of plugin.clients) {
                    const startedClient = await client.start(runtime);
                    const clientType = determineClientType(client);
                    elizaLogger.debug(
                        `Initializing client of type: ${clientType}`
                    );
                    clients[clientType] = startedClient;
                }
            }
        }
    }

    return clients;
}

function getSecret(character: Character, secret: string) {
    return character.settings?.secrets?.[secret] || process.env[secret];
}

let nodePlugin: any | undefined;

export async function createAgent(
    character: Character,
    db: IDatabaseAdapter,
    cache: ICacheManager,
    token: string
): Promise<AgentRuntime> {
    elizaLogger.log(`Creating runtime for character ${character.name}`);

    nodePlugin ??= createNodePlugin();

    const teeMode = getSecret(character, "TEE_MODE") || "OFF";
    const walletSecretSalt = getSecret(character, "WALLET_SECRET_SALT");

    // Validate TEE configuration
    if (teeMode !== TEEMode.OFF && !walletSecretSalt) {
        elizaLogger.error(
            "A WALLET_SECRET_SALT required when TEE_MODE is enabled"
        );
        throw new Error("Invalid TEE configuration");
    }

    let goatPlugin: any | undefined;

    if (getSecret(character, "EVM_PRIVATE_KEY")) {
        goatPlugin = await createGoatPlugin((secret) =>
            getSecret(character, secret)
        );
    }

    let zilliqaPlugin: any | undefined;
    if (getSecret(character, "ZILLIQA_PRIVATE_KEY")) {
        zilliqaPlugin = await createZilliqaPlugin((secret) =>
            getSecret(character, secret)
        );
    }

    // Initialize Reclaim adapter if environment variables are present
    // let verifiableInferenceAdapter;
    // if (
    //     process.env.RECLAIM_APP_ID &&
    //     process.env.RECLAIM_APP_SECRET &&
    //     process.env.VERIFIABLE_INFERENCE_ENABLED === "true"
    // ) {
    //     verifiableInferenceAdapter = new ReclaimAdapter({
    //         appId: process.env.RECLAIM_APP_ID,
    //         appSecret: process.env.RECLAIM_APP_SECRET,
    //         modelProvider: character.modelProvider,
    //         token,
    //     });
    //     elizaLogger.log("Verifiable inference adapter initialized");
    // }
    // Initialize Opacity adapter if environment variables are present
    let verifiableInferenceAdapter;
    if (
        process.env.OPACITY_TEAM_ID &&
        process.env.OPACITY_CLOUDFLARE_NAME &&
        process.env.OPACITY_PROVER_URL &&
        process.env.VERIFIABLE_INFERENCE_ENABLED === "true"
    ) {
        verifiableInferenceAdapter = new OpacityAdapter({
            teamId: process.env.OPACITY_TEAM_ID,
            teamName: process.env.OPACITY_CLOUDFLARE_NAME,
            opacityProverUrl: process.env.OPACITY_PROVER_URL,
            modelProvider: character.modelProvider,
            token: token,
        });
        elizaLogger.log("Verifiable inference adapter initialized");
        elizaLogger.log("teamId", process.env.OPACITY_TEAM_ID);
        elizaLogger.log("teamName", process.env.OPACITY_CLOUDFLARE_NAME);
        elizaLogger.log("opacityProverUrl", process.env.OPACITY_PROVER_URL);
        elizaLogger.log("modelProvider", character.modelProvider);
        elizaLogger.log("token", token);
    }
    if (
        process.env.PRIMUS_APP_ID &&
        process.env.PRIMUS_APP_SECRET &&
        process.env.VERIFIABLE_INFERENCE_ENABLED === "true"
    ) {
        verifiableInferenceAdapter = new PrimusAdapter({
            appId: process.env.PRIMUS_APP_ID,
            appSecret: process.env.PRIMUS_APP_SECRET,
            attMode: "proxytls",
            modelProvider: character.modelProvider,
            token,
        });
        elizaLogger.log("Verifiable inference primus adapter initialized");
    }

    return new AgentRuntime({
        databaseAdapter: db,
        token,
        modelProvider: character.modelProvider,
        evaluators: [],
        character,
        // character.plugins are handled when clients are added
        plugins: [
            parseBooleanFromText(getSecret(character, "BITMIND")) &&
            getSecret(character, "BITMIND_API_TOKEN")
                ? bittensorPlugin
                : null,
            parseBooleanFromText(
                getSecret(character, "EMAIL_AUTOMATION_ENABLED")
            )
                ? emailAutomationPlugin
                : null,
            getSecret(character, "IQ_WALLET_ADDRESS") &&
            getSecret(character, "IQSOlRPC")
                ? elizaCodeinPlugin
                : null,
            bootstrapPlugin,
            getSecret(character, "CDP_API_KEY_NAME") &&
            getSecret(character, "CDP_API_KEY_PRIVATE_KEY") &&
            getSecret(character, "CDP_AGENT_KIT_NETWORK")
                ? agentKitPlugin
                : null,
            getSecret(character, "DEXSCREENER_API_KEY")
                ? dexScreenerPlugin
                : null,
            getSecret(character, "FOOTBALL_API_KEY") ? footballPlugin : null,
            getSecret(character, "CONFLUX_CORE_PRIVATE_KEY")
                ? confluxPlugin
                : null,
            nodePlugin,
            getSecret(character, "ROUTER_NITRO_EVM_PRIVATE_KEY") &&
            getSecret(character, "ROUTER_NITRO_EVM_ADDRESS")
                ? nitroPlugin
                : null,
            getSecret(character, "TAVILY_API_KEY") ? webSearchPlugin : null,
            getSecret(character, "SOLANA_PUBLIC_KEY") ||
            (getSecret(character, "WALLET_PUBLIC_KEY") &&
                !getSecret(character, "WALLET_PUBLIC_KEY")?.startsWith("0x"))
                ? [solanaPlugin, solanaPluginV2]
                : null,
            getSecret(character, "SOLANA_PRIVATE_KEY")
                ? solanaAgentkitPlugin
                : null,
            getSecret(character, "AUTONOME_JWT_TOKEN") ? autonomePlugin : null,
            (getSecret(character, "NEAR_ADDRESS") ||
                getSecret(character, "NEAR_WALLET_PUBLIC_KEY")) &&
            getSecret(character, "NEAR_WALLET_SECRET_KEY")
                ? nearPlugin
                : null,
            getSecret(character, "EVM_PUBLIC_KEY") ||
            (getSecret(character, "WALLET_PUBLIC_KEY") &&
                getSecret(character, "WALLET_PUBLIC_KEY")?.startsWith("0x"))
                ? evmPlugin
                : null,
            (getSecret(character, "EVM_PRIVATE_KEY") ||
                getSecret(character, "SOLANA_PRIVATE_KEY"))
                ? edwinPlugin
                : null,
            (getSecret(character, "EVM_PUBLIC_KEY") ||
                getSecret(character, "INJECTIVE_PUBLIC_KEY")) &&
            getSecret(character, "INJECTIVE_PRIVATE_KEY")
                ? injectivePlugin
                : null,
            getSecret(character, "COSMOS_RECOVERY_PHRASE") &&
                getSecret(character, "COSMOS_AVAILABLE_CHAINS") &&
                createCosmosPlugin(),
            (getSecret(character, "SOLANA_PUBLIC_KEY") ||
                (getSecret(character, "WALLET_PUBLIC_KEY") &&
                    !getSecret(character, "WALLET_PUBLIC_KEY")?.startsWith(
                        "0x"
                    ))) &&
            getSecret(character, "SOLANA_ADMIN_PUBLIC_KEY") &&
            getSecret(character, "SOLANA_PRIVATE_KEY") &&
            getSecret(character, "SOLANA_ADMIN_PRIVATE_KEY")
                ? nftGenerationPlugin
                : null,
            getSecret(character, "ZEROG_PRIVATE_KEY") ? zgPlugin : null,
            getSecret(character, "COINMARKETCAP_API_KEY")
                ? coinmarketcapPlugin
                : null,
            getSecret(character, "ZERION_API_KEY") ? zerionPlugin : null,
            getSecret(character, "COINBASE_COMMERCE_KEY")
                ? coinbaseCommercePlugin
                : null,
            getSecret(character, "FAL_API_KEY") ||
            getSecret(character, "OPENAI_API_KEY") ||
            getSecret(character, "VENICE_API_KEY") ||
            getSecret(character, "NVIDIA_API_KEY") ||
            getSecret(character, "NINETEEN_AI_API_KEY") ||
            getSecret(character, "HEURIST_API_KEY") ||
            getSecret(character, "LIVEPEER_GATEWAY_URL")
                ? imageGenerationPlugin
                : null,
            getSecret(character, "FAL_API_KEY") ? ThreeDGenerationPlugin : null,
            ...(getSecret(character, "COINBASE_API_KEY") &&
            getSecret(character, "COINBASE_PRIVATE_KEY")
                ? [
                      coinbaseMassPaymentsPlugin,
                      tradePlugin,
                      tokenContractPlugin,
                      advancedTradePlugin,
                  ]
                : []),
            ...(teeMode !== TEEMode.OFF && walletSecretSalt ? [teePlugin] : []),
            teeMode !== TEEMode.OFF &&
            walletSecretSalt &&
            getSecret(character, "VLOG")
                ? verifiableLogPlugin
                : null,
            getSecret(character, "SGX") ? sgxPlugin : null,
            getSecret(character, "ENABLE_TEE_LOG") &&
            ((teeMode !== TEEMode.OFF && walletSecretSalt) ||
                getSecret(character, "SGX"))
                ? teeLogPlugin
                : null,
            getSecret(character, "OMNIFLIX_API_URL") &&
            getSecret(character, "OMNIFLIX_MNEMONIC")
                ? OmniflixPlugin
                : null,
            getSecret(character, "COINBASE_API_KEY") &&
            getSecret(character, "COINBASE_PRIVATE_KEY") &&
            getSecret(character, "COINBASE_NOTIFICATION_URI")
                ? webhookPlugin
                : null,
            goatPlugin,
            zilliqaPlugin,
            getSecret(character, "COINGECKO_API_KEY") ||
            getSecret(character, "COINGECKO_PRO_API_KEY")
                ? coingeckoPlugin
                : null,
            getSecret(character, "MORALIS_API_KEY") ? moralisPlugin : null,
            getSecret(character, "EVM_PROVIDER_URL") ? goatPlugin : null,
            getSecret(character, "ABSTRACT_PRIVATE_KEY")
                ? abstractPlugin
                : null,
            getSecret(character, "B2_PRIVATE_KEY") ? b2Plugin : null,
            getSecret(character, "BINANCE_API_KEY") &&
            getSecret(character, "BINANCE_SECRET_KEY")
                ? binancePlugin
                : null,
            getSecret(character, "FLOW_ADDRESS") &&
            getSecret(character, "FLOW_PRIVATE_KEY")
                ? flowPlugin
                : null,
            getSecret(character, "LENS_ADDRESS") &&
            getSecret(character, "LENS_PRIVATE_KEY")
                ? lensPlugin
                : null,
            getSecret(character, "APTOS_PRIVATE_KEY") ? aptosPlugin : null,
            getSecret(character, "MIND_COLD_WALLET_ADDRESS")
                ? mindNetworkPlugin
                : null,
            getSecret(character, "MVX_PRIVATE_KEY") ? multiversxPlugin : null,
            getSecret(character, "ZKSYNC_PRIVATE_KEY") ? zksyncEraPlugin : null,
            getSecret(character, "CRONOSZKEVM_PRIVATE_KEY")
                ? cronosZkEVMPlugin
                : null,
            getSecret(character, "TEE_MARLIN") ? teeMarlinPlugin : null,
            getSecret(character, "TON_PRIVATE_KEY") ? tonPlugin : null,
            getSecret(character, "THIRDWEB_SECRET_KEY") ? thirdwebPlugin : null,
            getSecret(character, "SUI_PRIVATE_KEY") ? suiPlugin : null,
            getSecret(character, "STORY_PRIVATE_KEY") ? storyPlugin : null,
            getSecret(character, "SQUID_SDK_URL") &&
            getSecret(character, "SQUID_INTEGRATOR_ID") &&
            getSecret(character, "SQUID_EVM_ADDRESS") &&
            getSecret(character, "SQUID_EVM_PRIVATE_KEY") &&
            getSecret(character, "SQUID_API_THROTTLE_INTERVAL")
                ? squidRouterPlugin
                : null,
            getSecret(character, "FUEL_PRIVATE_KEY") ? fuelPlugin : null,
            getSecret(character, "AVALANCHE_PRIVATE_KEY")
                ? avalanchePlugin
                : null,
            getSecret(character, "BIRDEYE_API_KEY") ? birdeyePlugin : null,
            getSecret(character, "ECHOCHAMBERS_API_URL") &&
            getSecret(character, "ECHOCHAMBERS_API_KEY")
                ? echoChambersPlugin
                : null,
            getSecret(character, "LETZAI_API_KEY") ? letzAIPlugin : null,
            getSecret(character, "STARGAZE_ENDPOINT") ? stargazePlugin : null,
            getSecret(character, "GIPHY_API_KEY") ? giphyPlugin : null,
            getSecret(character, "PASSPORT_API_KEY")
                ? gitcoinPassportPlugin
                : null,
            getSecret(character, "GENLAYER_PRIVATE_KEY")
                ? genLayerPlugin
                : null,
            getSecret(character, "AVAIL_SEED") &&
            getSecret(character, "AVAIL_APP_ID")
                ? availPlugin
                : null,
            getSecret(character, "OPEN_WEATHER_API_KEY")
                ? openWeatherPlugin
                : null,
            getSecret(character, "OBSIDIAN_API_TOKEN") ? obsidianPlugin : null,
            getSecret(character, "ARTHERA_PRIVATE_KEY")?.startsWith("0x")
                ? artheraPlugin
                : null,
            getSecret(character, "ALLORA_API_KEY") ? alloraPlugin : null,
            getSecret(character, "HYPERLIQUID_PRIVATE_KEY")
                ? hyperliquidPlugin
                : null,
            getSecret(character, "HYPERLIQUID_TESTNET")
                ? hyperliquidPlugin
                : null,
            getSecret(character, "AKASH_MNEMONIC") &&
            getSecret(character, "AKASH_WALLET_ADDRESS")
                ? akashPlugin
                : null,
            getSecret(character, "CHAINBASE_API_KEY") ? chainbasePlugin : null,
            getSecret(character, "QUAI_PRIVATE_KEY") ? quaiPlugin : null,
            getSecret(character, "RESERVOIR_API_KEY")
                ? createNFTCollectionsPlugin()
                : null,
            getSecret(character, "ZERO_EX_API_KEY") ? zxPlugin : null,
            getSecret(character, "DKG_PRIVATE_KEY") ? dkgPlugin : null,
            getSecret(character, "PYTH_TESTNET_PROGRAM_KEY") ||
            getSecret(character, "PYTH_MAINNET_PROGRAM_KEY")
                ? pythDataPlugin
                : null,
            getSecret(character, "LND_TLS_CERT") &&
            getSecret(character, "LND_MACAROON") &&
            getSecret(character, "LND_SOCKET")
                ? lightningPlugin
                : null,
            getSecret(character, "OPENAI_API_KEY") &&
            parseBooleanFromText(
                getSecret(character, "ENABLE_OPEN_AI_COMMUNITY_PLUGIN")
            )
                ? openaiPlugin
                : null,
            getSecret(character, "DEVIN_API_TOKEN") ? devinPlugin : null,
            getSecret(character, "INITIA_PRIVATE_KEY") ? initiaPlugin : null,
            getSecret(character, "HOLDSTATION_PRIVATE_KEY")
                ? holdstationPlugin
                : null,
            getSecret(character, "NVIDIA_NIM_API_KEY") ||
            getSecret(character, "NVIDIA_NGC_API_KEY")
                ? nvidiaNimPlugin
                : null,
            getSecret(character, "BNB_PRIVATE_KEY") ||
            getSecret(character, "BNB_PUBLIC_KEY")?.startsWith("0x")
                ? bnbPlugin
                : null,
            (getSecret(character, "EMAIL_INCOMING_USER") &&
                getSecret(character, "EMAIL_INCOMING_PASS")) ||
            (getSecret(character, "EMAIL_OUTGOING_USER") &&
                getSecret(character, "EMAIL_OUTGOING_PASS"))
                ? emailPlugin
                : null,
            getSecret(character, "SEI_PRIVATE_KEY") ? seiPlugin : null,
            getSecret(character, "HYPERBOLIC_API_KEY")
                ? hyperbolicPlugin
                : null,
            getSecret(character, "SUNO_API_KEY") ? sunoPlugin : null,
            getSecret(character, "UDIO_AUTH_TOKEN") ? udioPlugin : null,
            getSecret(character, "IMGFLIP_USERNAME") &&
            getSecret(character, "IMGFLIP_PASSWORD")
                ? imgflipPlugin
                : null,
            getSecret(character, "FUNDING_PRIVATE_KEY") &&
            getSecret(character, "EVM_RPC_URL")
                ? litPlugin
                : null,
            getSecret(character, "ETHSTORAGE_PRIVATE_KEY")
                ? ethstoragePlugin
                : null,
            getSecret(character, "MINA_PRIVATE_KEY") ? minaPlugin : null,
            getSecret(character, "FORM_PRIVATE_KEY") ? formPlugin : null,
            getSecret(character, "ANKR_WALLET") ? ankrPlugin : null,
            getSecret(character, "DCAP_EVM_PRIVATE_KEY") &&
            getSecret(character, "DCAP_MODE")
                ? dcapPlugin
                : null,
            getSecret(character, "QUICKINTEL_API_KEY")
                ? quickIntelPlugin
                : null,
            getSecret(character, "GELATO_RELAY_API_KEY") ? gelatoPlugin : null,
            getSecret(character, "TRIKON_WALLET_ADDRESS") ? trikonPlugin : null,
            getSecret(character, "ARBITRAGE_EVM_PRIVATE_KEY") &&
            (getSecret(character, "ARBITRAGE_EVM_PROVIDER_URL") ||
                getSecret(character, "ARBITRAGE_ETHEREUM_WS_URL")) &&
            getSecret(character, "ARBITRAGE_FLASHBOTS_RELAY_SIGNING_KEY") &&
            getSecret(character, "ARBITRAGE_BUNDLE_EXECUTOR_ADDRESS")
                ? arbitragePlugin
                : null,
            getSecret(character, "DESK_EXCHANGE_PRIVATE_KEY") ||
            getSecret(character, "DESK_EXCHANGE_NETWORK")
                ? deskExchangePlugin
                : null,
        ]
            .flat()
            .filter(Boolean),
        providers: [],
        managers: [],
        cacheManager: cache,
        fetch: logFetch,
        verifiableInferenceAdapter,
    });
}

function initializeFsCache(baseDir: string, character: Character) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cacheDir = path.resolve(baseDir, character.id, "cache");

    const cache = new CacheManager(new FsCacheAdapter(cacheDir));
    return cache;
}

function initializeDbCache(character: Character, db: IDatabaseCacheAdapter) {
    if (!character?.id) {
        throw new Error(
            "initializeFsCache requires id to be set in character definition"
        );
    }
    const cache = new CacheManager(new DbCacheAdapter(db, character.id));
    return cache;
}

function initializeCache(
    cacheStore: string,
    character: Character,
    baseDir?: string,
    db?: IDatabaseCacheAdapter
) {
    switch (cacheStore) {
        case CacheStore.REDIS:
            if (process.env.REDIS_URL) {
                elizaLogger.info("Connecting to Redis...");
                const redisClient = new RedisClient(process.env.REDIS_URL);
                if (!character?.id) {
                    throw new Error(
                        "CacheStore.REDIS requires id to be set in character definition"
                    );
                }
                return new CacheManager(
                    new DbCacheAdapter(redisClient, character.id) // Using DbCacheAdapter since RedisClient also implements IDatabaseCacheAdapter
                );
            } else {
                throw new Error("REDIS_URL environment variable is not set.");
            }

        case CacheStore.DATABASE:
            if (db) {
                elizaLogger.info("Using Database Cache...");
                return initializeDbCache(character, db);
            } else {
                throw new Error(
                    "Database adapter is not provided for CacheStore.Database."
                );
            }

        case CacheStore.FILESYSTEM:
            elizaLogger.info("Using File System Cache...");
            if (!baseDir) {
                throw new Error(
                    "baseDir must be provided for CacheStore.FILESYSTEM."
                );
            }
            return initializeFsCache(baseDir, character);

        default:
            throw new Error(
                `Invalid cache store: ${cacheStore} or required configuration missing.`
            );
    }
}

async function startAgent(
    character: Character,
    directClient: DirectClient,
    db: TypeDatabaseAdapter
): Promise<AgentRuntime> {
    try {
        character.id ??= stringToUuid(character.name);
        character.username ??= character.name;

        const token = getTokenForProvider(character.modelProvider, character);

        const cache = initializeCache(
            process.env.CACHE_STORE ?? CacheStore.DATABASE,
            character,
            "",
            db
        ); // "" should be replaced with dir for file system caching. THOUGHTS: might probably make this into an env
        const runtime: AgentRuntime = await createAgent(
            character,
            db,
            cache,
            token
        );

        // start services/plugins/process knowledge
        await runtime.initialize();

        // start assigned clients
        runtime.clients = await initializeClients(character, runtime);

        // add to container
        directClient.registerAgent(runtime);

        // report to console
        elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

        return runtime;
    } catch (error) {
        elizaLogger.error(
            `Error starting agent for character ${character.name}:`,
            error
        );
        elizaLogger.error(error);
        throw error;
    }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
        const server = net.createServer();

        server.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
                resolve(false);
            }
        });

        server.once("listening", () => {
            server.close();
            resolve(true);
        });

        server.listen(port);
    });
};

const hasValidRemoteUrls = () =>
    process.env.REMOTE_CHARACTER_URLS &&
    process.env.REMOTE_CHARACTER_URLS !== "" &&
    process.env.REMOTE_CHARACTER_URLS.startsWith("http");

const startAgents = async () => {
    const directClient = new DirectClient();
    let serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
    const args = parseArguments();
    const charactersArg = args.characters || args.character;
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase(dataDir) as TypeDatabaseAdapter;

    await db.init();

    let characters = [defaultCharacter];

    if (process.env.IQ_WALLET_ADDRESS && process.env.IQSOlRPC) {
        characters = await loadCharacterFromOnchain();
    }

    const notOnchainJson = !onchainJson || onchainJson == "null";

    if ((notOnchainJson && charactersArg) || hasValidRemoteUrls()) {
        characters = await loadCharacters(charactersArg);
    }

    // Normalize characters for injectable plugins
    characters = await Promise.all(characters.map(normalizeCharacter));

    try {
        for (const character of characters) {
            await startAgent(character, directClient, db);
        }
    } catch (error) {
        elizaLogger.error("Error starting agents:", error);
    }

    // Find available port
    while (!(await checkPortAvailable(serverPort))) {
        elizaLogger.warn(
            `Port ${serverPort} is in use, trying ${serverPort + 1}`
        );
        serverPort++;
    }

    // upload some agent functionality into directClient
    directClient.startAgent = async (character) => {
        // Handle plugins
        character.plugins = await handlePluginImporting(character.plugins);

        // wrap it so we don't have to inject directClient later
        return startAgent(character, directClient, db);
    };

    directClient.loadCharacterTryPath = loadCharacterTryPath;
    directClient.jsonToCharacter = jsonToCharacter;
    directClient.db = db;

    directClient.start(serverPort);

    if (serverPort !== Number.parseInt(settings.SERVER_PORT || "3000")) {
        elizaLogger.log(`Server started on alternate port ${serverPort}`);
    }

    elizaLogger.info(
        "Run `pnpm start:client` to start the client and visit the outputted URL (http://localhost:5173) to chat with your agents. When running multiple agents, use client with different port `SERVER_PORT=3001 pnpm start:client`"
    );
};

startAgents().catch((error) => {
    elizaLogger.error("Unhandled error in startAgents:", error);
    process.exit(1);
});

// Prevent unhandled exceptions from crashing the process if desired
if (
    process.env.PREVENT_UNHANDLED_EXIT &&
    parseBooleanFromText(process.env.PREVENT_UNHANDLED_EXIT)
) {
    // Handle uncaught exceptions to prevent the process from crashing
    process.on("uncaughtException", function (err) {
        console.error("uncaughtException", err);
    });

    // Handle unhandled rejections to prevent the process from crashing
    process.on("unhandledRejection", function (err) {
        console.error("unhandledRejection", err);
    });
}
