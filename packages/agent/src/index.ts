// dotenv
import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import {
    type Adapter,
    AgentRuntime,
    CacheManager,
    CacheStore,
    type Character,
    DbCacheAdapter,
    type IAgentRuntime,
    type IDatabaseAdapter,
    type IDatabaseCacheAdapter,
    logger,
    parseBooleanFromText,
    settings,
    stringToUuid,
    validateCharacterConfig
} from "@elizaos/core";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { defaultCharacter } from "./defaultCharacter.ts";
import { CharacterServer } from "./server";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename); // get the name of the directory

export const wait = (minTime = 1000, maxTime = 3000) => {
    const waitTime =
        Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    return new Promise((resolve) => setTimeout(resolve, waitTime));
};

export const logFetch = async (url: string, options: any) => {
    logger.debug(`Fetching ${url}`);
    // Disabled to avoid disclosure of sensitive information such as API keys
    // logger.debug(JSON.stringify(options, null, 2));
    return fetch(url, options);
};

export function parseArguments(): {
    character?: string;
    characters?: string;
} {
    try {
        return yargs(process.argv.slice(2))
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
        logger.error("Error parsing arguments:", error);
        return {};
    }
}

export function tryLoadFile(filePath: string): string | null {
    try {
        return fs.readFileSync(filePath, "utf8");
    } catch (e) {
        return null;
    }
}

export function mergeCharacters(base: Character, child: Character): Character {
    const mergeObjects = (baseObj: any, childObj: any) => {
        const result: any = {};
        const keys = new Set([
            ...Object.keys(baseObj || {}),
            ...Object.keys(childObj || {}),
        ]);
        for (const key of keys) {
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
        }
        return result;
    };
    return mergeObjects(base, child);
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
        logger.error(`Error loading character(s) from ${url}: ${e}`);
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
    if (character.extends) {
        logger.info(
            `Merging  ${character.name} character with parent characters`
        );
        for (const extendPath of character.extends) {
            const baseCharacter = await loadCharacter(
                path.resolve(path.dirname(filePath), extendPath)
            );
            character = mergeCharacters(baseCharacter, character);
            logger.info(
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
        path.resolve(process.cwd(), '..', '..', characterPath), // relative to root directory
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

    logger.info(
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
        logger.error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
        logger.error("Tried the following paths:");
        for (const p of pathsToTry) {
            logger.error(` - ${p}`);
        }
        throw new Error(
            `Error loading character from ${characterPath}: File not found in any of the expected locations`
        );
    }
    try {
        const character: Character = await loadCharacter(resolvedPath);
        logger.info(`Successfully loaded character from: ${resolvedPath}`);
        return character;
    } catch (e) {
        logger.error(`Error parsing character from ${resolvedPath}: ${e}`);
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
        for (const fileName of fileNames) {
            characterPaths.push(path.join(uploadDir, fileName));
        }
    } catch (err) {
        logger.error(`Error reading directory: ${err.message}`);
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
                logger.error(`Error loading character from ${characterPath}: ${e}`);
                process.exit(1);
            }
        }
    }

    if (hasValidRemoteUrls()) {
        logger.info("Loading characters from remote URLs");
        const characterUrls = commaSeparatedStringToArray(
            process.env.REMOTE_CHARACTER_URLS
        );
        for (const characterUrl of characterUrls) {
            const characters = await loadCharactersFromUrl(characterUrl);
            loadedCharacters.push(...characters);
        }
    }

    if (loadedCharacters.length === 0) {
        logger.info("No characters found, using default character");
        loadedCharacters.push(defaultCharacter);
    }

    return loadedCharacters;
}

export async function createAgent(
    character: Character,
): Promise<IAgentRuntime> {
    logger.log(`Creating runtime for character ${character.name}`);
    return new AgentRuntime({
        character,
        fetch: logFetch,
    });
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
        case CacheStore.DATABASE:
            if (db) {
                logger.info("Using Database Cache...");
                return initializeDbCache(character, db);
            }
                throw new Error(
                    "Database adapter is not provided for CacheStore.Database."
                );

        default:
            throw new Error(
                `Invalid cache store: ${cacheStore} or required configuration missing.`
            );
    }
}

async function findDatabaseAdapter(runtime: IAgentRuntime) {
  const { adapters } = runtime;
  let adapter: Adapter | undefined;
  // if not found, default to sqlite
  if (adapters.length === 0) {
    const sqliteAdapterPlugin = await import('@elizaos-plugins/sqlite');
    const sqliteAdapterPluginDefault = sqliteAdapterPlugin.default;
    adapter = sqliteAdapterPluginDefault.adapters[0];
    if (!adapter) {
      throw new Error("Internal error: No database adapter found for default plugin-sqlite");
    }
  } else if (adapters.length === 1) {
    adapter = adapters[0];
  } else {
    throw new Error("Multiple database adapters found. You must have no more than one. Adjust your plugins configuration.");
    }
  const adapterInterface = adapter?.init(runtime);
  return adapterInterface;
}

async function startAgent(
    character: Character,
    characterServer: CharacterServer
): Promise<IAgentRuntime> {
    let db: IDatabaseAdapter & IDatabaseCacheAdapter;
    try {
        character.id ??= stringToUuid(character.name);
        character.username ??= character.name;

        const runtime: IAgentRuntime = await createAgent(
            character
        );

        // initialize database
        // find a db from the plugins
        db = await findDatabaseAdapter(runtime);
        runtime.databaseAdapter = db;

        // initialize cache
        const cache = initializeCache(
            runtime.getSetting("CACHE_STORE") ?? CacheStore.DATABASE,
            character,
            "",
            db
        ); // "" should be replaced with dir for file system caching. THOUGHTS: might probably make this into an env
        runtime.cacheManager = cache;

        // start services/plugins/process knowledge
        await runtime.initialize();

        // add to container
        characterServer.registerAgent(runtime);

        // report to console
        logger.debug(`Started ${character.name} as ${runtime.agentId}`);

        return runtime;
    } catch (error) {
        logger.error(
            `Error starting agent for character ${character.name}:`,
            error
        );
        logger.error(error);
        if (db) {
            await db.close();
        }
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
    const characterServer = new CharacterServer();
    let serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
    const args = parseArguments();
    const charactersArg = args.characters || args.character;
    let characters = [defaultCharacter];

    if ((charactersArg) || hasValidRemoteUrls()) {
        characters = await loadCharacters(charactersArg);
    }

    try {
        for (const character of characters) {
            await startAgent(character, characterServer);
        }
    } catch (error) {
        logger.error("Error starting agents:", error);
    }

    // Find available port
    while (!(await checkPortAvailable(serverPort))) {
        logger.warn(
            `Port ${serverPort} is in use, trying ${serverPort + 1}`
        );
        serverPort++;
    }

    // upload some agent functionality into characterServer
    // XXX TODO: is this still used?
    characterServer.startAgent = async (character) => {
        logger.info(`Starting agent for character ${character.name}`);
        // wrap it so we don't have to inject characterServer later
        return startAgent(character, characterServer);
    };

    characterServer.loadCharacterTryPath = loadCharacterTryPath;
    characterServer.jsonToCharacter = jsonToCharacter;

    characterServer.start(serverPort);

    if (serverPort !== Number.parseInt(settings.SERVER_PORT || "3000")) {
        logger.log(`Server started on alternate port ${serverPort}`);
    }

    logger.info(
        "Run `bun start:client` to start the client and visit the outputted URL (http://localhost:5173) to chat with your agents. When running multiple agents, use client with different port `SERVER_PORT=3001 bun start:client`"
    );
};

startAgents().catch((error) => {
    logger.error("Unhandled error in startAgents:", error);
    process.exit(1);
});

// Prevent unhandled exceptions from crashing the process if desired
if (
    process.env.PREVENT_UNHANDLED_EXIT &&
    parseBooleanFromText(process.env.PREVENT_UNHANDLED_EXIT)
) {
    // Handle uncaught exceptions to prevent the process from crashing
    process.on("uncaughtException", (err) => {
        console.error("uncaughtException", err);
    });

    // Handle unhandled rejections to prevent the process from crashing
    process.on("unhandledRejection", (err) => {
        console.error("unhandledRejection", err);
    });
}