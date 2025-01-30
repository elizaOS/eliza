import type { NoteContent, ResultNoteApi, ResultNoteSearchApi, ServerInfo } from "../types";
import { createHash } from "node:crypto";
import {
    elizaLogger,
    type AgentRuntime,
    knowledge,
    stringToUuid,
} from "@elizaos/core";

export class ObsidianProvider {
    private connected = false;
    private runtime: AgentRuntime;
    private static instance: ObsidianProvider | null = null;

    private constructor(
        private port = 27123,
        private token: string,
        private host_url: string
    ) {}

    /**
     * Creates an instance of the ObsidianProvider class.
     * @param runtime - The agent runtime.
     * @param port - The port number to use for the Obsidian server.
     * @param token - The authentication token for the Obsidian server.
     * @param host_url - The URL of the Obsidian server.
     * @returns An instance of the ObsidianProvider class.
     */
    static async create(
        runtime: AgentRuntime,
        port: number,
        token: string,
        host_url = `http://127.0.0.1:${port}`
    ): Promise<ObsidianProvider> {
        if (!this.instance) {
            this.instance = new ObsidianProvider(port, token, host_url);
            await this.instance.connect();
            this.instance.runtime = runtime;
        }
        return this.instance;
    }

    /**
     * Opens a file in Obsidian by its path.
     * @param filePath - The path to the file within the vault.
     * @returns A promise that resolves when the file is successfully opened.
     */
    async connect(): Promise<void> {
        if (this.connected) return;

        try {
            const response = await fetch(`${this.host_url}/`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const serverInfo: ServerInfo = await response.json();

            if (!serverInfo.authenticated) {
                throw new Error("Failed to authenticate with Obsidian API");
            }

            this.connected = true;
        } catch (error) {
            elizaLogger.error("Failed to connect to Obsidian:", error.message);
            this.connected = false;
            throw error;
        }
    }

    /**
     * Retrieves a list of all notes within the vault.
     * @returns A promise that resolves to an array of note paths.
     */
    async listNotes(): Promise<string[]> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(`${this.host_url}/vault/`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    accept: "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const notes: string[] = await response.json();
            return notes;
        } catch (error) {
            elizaLogger.error("Failed to list notes:", error.message);
            throw error;
        }
    }

    /**
     * Retrieves the content of a specific note.
     * @param path - The path to the note within the vault.
     * @returns A promise that resolves to the content of the note.
     */
    async getNote(path: string): Promise<NoteContent> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `${this.host_url}/vault/${encodeURIComponent(
                    path
                )}`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        accept: "application/vnd.olrapi.note+json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const noteContent: NoteContent = await response.json();
            return noteContent;
        } catch (error) {
            elizaLogger.error("Failed to fetch note content:", error);
            throw error;
        }
    }

    /**
     * Retrieves the content of the currently active note.
     * @returns A promise that resolves to the content of the active note.
     */
    async getActiveNote(): Promise<NoteContent> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `${this.host_url}/active/`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        accept: "application/vnd.olrapi.note+json",
                    },
                }
            );

            if (!response.ok) {
                if (response.status === 404) {
                    throw new Error("No active file found in Obsidian");
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const noteContent: NoteContent = await response.json();
            return noteContent;
        } catch (error) {
            elizaLogger.error("Failed to fetch active note content:", error.message);
            throw error;
        }
    }

    /**
     * Saves the content of a note to the vault.
     * @param path - The path to the note within the vault.
     * @param content - The content to save to the note.
     * @param createDirectories - Whether to create directories if they don't exist.
     * @returns A promise that resolves when the note is successfully saved.
     */
    async saveNote(
        path: string,
        content: string,
        createDirectories = true
    ): Promise<void> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const createDirsString = createDirectories.toString();
            const response = await fetch(
                `${this.host_url}/vault/${encodeURIComponent(path)}`,
                {
                    method: "PUT",
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        "Content-Type": "text/markdown",
                        "X-Create-Directories": createDirsString,
                    },
                    body: content,
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            elizaLogger.error("Failed to save note:", error.message);
            throw error;
        }
    }

    /**
     * Retrieves a list of all files within the vault.
     * @returns A promise that resolves to an array of file paths.
     */
    async listFiles(): Promise<string[]> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(`${this.host_url}/vault/`, {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    accept: "application/json",
                },
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const vault: Record<string, string[]> = await response.json();
            return vault.files as string[];
        } catch (error) {
            elizaLogger.error("Failed to list files:", error.message);
            throw error;
        }
    }

    /**
     * Retrieves a list of all files within a specific directory.
     * @param directoryPath - The path to the directory within the vault.
     * @returns A promise that resolves to an array of file paths.
     */
    async listDirectoryFiles(directoryPath: string): Promise<string[]> {
        if (!this.connected) {
            await this.connect();
        }

        if (directoryPath.match(/\/$/)) {
            directoryPath = `${directoryPath.replace(/\/$/, "")}`;
        }

        try {
            const response = await fetch(
                `${this.host_url}/vault/${encodeURIComponent(directoryPath)}/`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        accept: "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const vaultDirectory: Record<string, string[]> = await response.json();
            return vaultDirectory.files as string[];
        } catch (error) {
            elizaLogger.error("Failed to list directory contents:", error.message);
            throw error;
        }
    }

    /**
     * Retrieves the content of a specific file from the vault.
     * @param path - The path to the file within the vault.
     * @returns A promise that resolves to the content of the file.
     */
    async readFile(path: string): Promise<string> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `${this.host_url}/vault/${encodeURIComponent(path)}`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        accept: "text/markdown",
                        "Content-Type": "text/markdown",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const content: string = await response.text();
            return content;
        } catch (error) {
            elizaLogger.error("Failed to read file content:", error.message);
            throw error;
        }
    }


    /**
     * Opens a file in Obsidian by its path.
     * @param filePath - The path to the file within the vault.
     * @returns A promise that resolves when the file is successfully opened.
     */
    async openFile(filePath: string): Promise<void> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `${this.host_url}/open/${encodeURIComponent(filePath)}`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            elizaLogger.success(`Successfully opened file: ${filePath}`);
        } catch (error) {
            elizaLogger.error(`Failed to open file '${filePath}':`, error.message);
            throw error;
        }
    }

    /**
     * Saves the content of a file to the vault.
     * Note: Obsidian will create a new document at the path you have specified if such a document did not already exist
     * @param path - The path to the file within the vault.
     * @param content - The content to save to the file.
     * @param createDirectories - Whether to create directories if they don't exist.
     * @returns A promise that resolves when the file is successfully saved.
     */
    async saveFile(
        path: string,
        content: string,
        createDirectories = true
    ): Promise<void> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const createDirsString = createDirectories.toString();
            const response = await fetch(
                `${this.host_url}/vault/${encodeURIComponent(path)}`,
                {
                    method: "PUT",
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        "Content-Type": "text/markdown",
                        "X-Create-Directories": createDirsString,
                    },
                    body: content,
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            elizaLogger.error("Failed to save file:", error.message);
            throw error;
        }
    }

    /**
     * Inserts content into a specific section of a file.
     * @param path - The path to the file within the vault.
     * @param content - The content to insert into the file.
     * @param lineNumber - The line number to insert the content at.
     * @returns A promise that resolves when the file is successfully patched.
     */
    async patchFile(
        path: string,
        content: string,
        lineNumber = 0
    ): Promise<void> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `${this.host_url}/vault/${encodeURIComponent(path)}`,
                {
                    method: "PATCH",
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ content, line: lineNumber }),
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            elizaLogger.error("Failed to patch file content:", error.message);
            throw error;
        }
    }

    /**
     * Retrieves a list of all available Obsidian commands.
     * @returns A promise that resolves to an array of command objects, each containing an ID and name.
     */
    async listCommands(): Promise<{ id: string; name: string }[]> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `${this.host_url}/commands/`,
                {
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        accept: "application/json",
                    },
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const commands: { id: string; name: string }[] = await response.json();
            return commands;
        } catch (error) {
            elizaLogger.error("Failed to list commands:", error.message);
            throw error;
        }
    }

    /**
     * Executes an Obsidian command by its command ID.
     * @param commandId - The ID of the command to execute.
     * @returns A promise that resolves when the command is successfully executed.
     */
    async executeCommand(commandId: string): Promise<void> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            const response = await fetch(
                `${this.host_url}/commands/execute`,
                {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ commandId }),
                }
            );

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
        } catch (error) {
            elizaLogger.error("Failed to execute command:", error.message);
            throw error;
        }
    }

    /**
     * Searches for notes in the vault based on the provided query and options.
     * @param query - The query to search for. Can be a string or an object.
     * @param queryFormat - The format of the query (plaintext, dataview, or jsonlogic).
     * @param options - Additional options for the search.
     * @returns A promise that resolves to an array of search results.
     */
    async search(
        query: string | object,
        queryFormat: 'plaintext' | 'dataview' | 'jsonlogic' = 'plaintext',
        options: {
            contextLength?: number;
            ignoreCase?: boolean;
            isRegex?: boolean;
            searchIn?: string[];
        } = {}
    ): Promise<ResultNoteApi[]|ResultNoteSearchApi[]> {
        if (!this.connected) {
            await this.connect();
        }

        //ignoreCase = true, isRegex = false, searchIn = []
        const { contextLength = 100 } = options;

        // Determine Content-Type and body based on queryFormat
        let contentType: string;
        let body: string;

        switch (queryFormat) {
            case 'dataview':
                contentType = 'application/vnd.olrapi.dataview.dql+txt';
                if (typeof query !== 'string') {
                    throw new Error('Dataview query must be a string.');
                }
                body = query;
                break;
            case 'jsonlogic':
                contentType = 'application/vnd.olrapi.jsonlogic+json';
                if (typeof query !== 'object') {
                    throw new Error('JsonLogic query must be an object.');
                }
                body = JSON.stringify(query);
                break;
            default:
                contentType = 'application/json';
                if (typeof query !== 'string') {
                    throw new Error('Plaintext query must be a string.');
                }
                body = query;
                break;
        }

        try {

            elizaLogger.log(
                `Processing search query with format ${queryFormat}:`,
                body
            );

            if (queryFormat === 'dataview' || queryFormat === 'jsonlogic') {
                const response = await fetch(`${this.host_url}/search`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        'Content-Type': contentType,
                        Accept: 'application/json',
                    },
                    body: body,
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const results: ResultNoteSearchApi[] = await response.json();
                return results;
            }

            const response = await fetch(`${this.host_url}/search/simple?query=${encodeURIComponent(body)}&contextLength=${contextLength}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    'Content-Type': contentType,
                    Accept: 'application/json',
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const results: ResultNoteApi[] = await response.json();
            return results;
        } catch (error) {
            elizaLogger.error('Search failed:', error.message);
            throw error;
        }
    }


    /**
     * Searches for notes in the vault based on the provided query and options.
     * @param query - The query to search for. Can be a string or an object.
     * @param queryFormat - The format of the query (plaintext, dataview, or jsonlogic).
     * @param options - Additional options for the search.
     * @returns A promise that resolves to an array of search results.
     */
    async searchKeywords(
        query: string,
        contextLength = 100
    ): Promise<ResultNoteApi[]> {
        if (!this.connected) {
            await this.connect();
        }

        // Split on OR to get main chunks
        const orQueries = query.split(/\s+OR\s+/).map((q) => q.trim());

        elizaLogger.log(
            'Processing search query with OR operator:',
            orQueries
        );

        try {
            const allResults: ResultNoteApi[] = [];

            // Handle each OR chunk separately
            for (const orQuery of orQueries) {
                const response = await fetch(
                    `${this.host_url}/search/simple/?query=${encodeURIComponent(orQuery)}&contextLength=${contextLength}`,
                    {
                        method: "POST",
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            accept: "application/json",
                        },
                    }
                );

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const results: ResultNoteApi[] = await response.json();
                allResults.push(...results);
            }

            // Remove duplicates based on filename
            const uniqueResults = Array.from(
                new Map(
                    allResults.map((item) => [item.filename, item])
                ).values()
            );

            elizaLogger.success(`Found ${uniqueResults.length} unique results`);
            elizaLogger.debug("Search results:", uniqueResults);
            return uniqueResults;
        } catch (error) {
            elizaLogger.error("Obsidian search failed:", error.message);
            throw error;
        }
    }


    /**
     * Recursively scans directories and builds a list of all files
     * @param directory - The directory to scan, empty string for root
     * @returns Array of file paths in format 'directory/file.md'
     */
    private async scanDirectoryRecursively(directory = ''): Promise<string[]> {
        const allFiles: string[] = [];
        const dirsToProcess: string[] = [directory];
        const processedDirs = new Set<string>();

        while (dirsToProcess.length > 0) {
            const currentDir = dirsToProcess.shift();
            if (currentDir === undefined) continue;

            if (processedDirs.has(currentDir)) {
                continue;
            }

            try {
                elizaLogger.debug("Scanning directory:", currentDir);
                const items = await this.listDirectoryFiles(currentDir);

                for (const item of items) {
                    if (item.endsWith('/')) {
                        // It's a directory, add to processing queue
                        const fullPath = currentDir ? `${currentDir}${item}` : item;
                        if (!processedDirs.has(fullPath)) {
                            dirsToProcess.push(fullPath);
                        }
                    } else if (item.endsWith('.md')) {
                        // It's a markdown file, add to results
                        const filePath = currentDir ? `${currentDir}${item}` : item;
                        allFiles.push(filePath);
                    }
                }

                processedDirs.add(currentDir);
            } catch (error) {
                elizaLogger.error(`Error scanning directory ${currentDir}:`, error);
            }
        }

        return allFiles;
    }

    /**
     * Retrieves all files in the vault.
     * @returns A promise that resolves to an array of file paths.
     */
    async getAllFiles(): Promise<string[]> {
        if (!this.connected) {
            await this.connect();
        }

        try {
            elizaLogger.debug("Starting file scanning process");

            // Get root files and directories
            const rootItems = await this.listFiles();
            const allFiles: string[] = [];

            // Process root level markdown files
            const rootMdFiles = rootItems.filter(item => item.endsWith('.md'));
            allFiles.push(...rootMdFiles);

            // Process directories
            const directories = rootItems.filter(item => item.endsWith('/'));
            for (const dir of directories) {
                const dirFiles = await this.scanDirectoryRecursively(dir);
                allFiles.push(...dirFiles);
            }

            elizaLogger.info(`Completed scanning. Found ${allFiles.length} files in vault`);

            // Remove any duplicates
            const uniqueFiles = Array.from(new Set(allFiles));

            return uniqueFiles;
        } catch (error) {
            elizaLogger.error("Error in getAllFiles:", error);
            throw error;
        }
    }

    /**
     * Creates memories from all files in the vault.
     * @returns A promise that resolves to the number of memories created.
     */
    async createMemoriesFromFiles(): Promise<number> {
        try {
            elizaLogger.info("Starting to create memories from vault files");
            const allFiles = await this.getAllFiles();

            elizaLogger.debug("All files:", allFiles);
            elizaLogger.success(`Found ${allFiles.length} files in vault`);
            //return allFiles;

            for (const file of allFiles) {
                try {
                    if (file.endsWith('.md')) {
                        // Get the file content
                        const content = await this.getNote(file);
                        if (!content) {
                            elizaLogger.warn(`No content found for file: ${file}`);
                            continue;
                        }

                        const contentHash = createHash("sha256")
                            .update(JSON.stringify(content))
                            .digest("hex");

                        const knowledgeId = stringToUuid(
                            `obsidian-${file}`
                        );

                        const existingDocument =
                            await this.runtime.documentsManager.getMemoryById(knowledgeId);

                        if (
                            existingDocument &&
                            existingDocument.content.hash === contentHash
                        ) {
                            elizaLogger.debug(`Skipping unchanged file: ${file}`);
                            continue;
                        }

                        elizaLogger.info(
                            `Processing knowledge for ${this.runtime.character.name} - ${file}`
                        );

                        await knowledge.set(this.runtime, {
                            id: knowledgeId,
                            content: {
                                text: content.content,
                                hash: contentHash,
                                source: "obsidian",
                                attachments: [],
                                metadata: {
                                    path: file,
                                    tags: content.tags,
                                    frontmatter: content.frontmatter,
                                    stats: content.stat
                                },
                            },
                        });

                        // delay to avoid throttling
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                } catch (error) {
                    elizaLogger.error(`Error processing file ${file}:`, error);
                    // continue;
                }
            }

            elizaLogger.success("Finished creating memories from vault notes");

            return allFiles.length;

        } catch (error) {
            elizaLogger.error("Error in createMemoriesFromFiles:", error);
            return 0;
        }
    }

    /**
     * Checks if the client is connected to Obsidian.
     * @returns `true` if the client is connected, `false` otherwise.
     */
    isConnected(): boolean {
        return this.connected;
    }

    /**
     * Closes the connection to Obsidian.
     */
    close() {
        this.connected = false;
        ObsidianProvider.instance = null;
    }
}
