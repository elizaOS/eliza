import {
    IAgentRuntime,
    ICacheManager,
    Memory,
    Provider,
    State,
} from "@ai16z/eliza";
import { createGraphRAG } from "./driver";
import {
    GraphRAGResponse,
    DocumentRelationType,
    NodeProperties,
} from "./types";
import NodeCache from "node-cache";
import * as path from "path";

const PROVIDER_CONFIG = {
    MAX_RETRIES: 3,
    RETRY_DELAY: 2000,
};

export class RAGGraphProvider {
    private cache: NodeCache;
    private cacheKey: string = "raggraph";
    private graphRAG;

    constructor(
        private neo4jUri: string,
        private neo4jUser: string,
        private neo4jPassword: string,
        private cacheManager: ICacheManager
    ) {
        this.cache = new NodeCache({ stdTTL: 300 }); // Cache TTL set to 5 minutes
        this.graphRAG = createGraphRAG({
            neo4jUri: this.neo4jUri,
            neo4jUser: this.neo4jUser,
            neo4jPassword: this.neo4jPassword,
        });
    }

    private async readFromCache<T>(key: string): Promise<T | null> {
        const cached = await this.cacheManager.get<T>(
            path.join(this.cacheKey, key)
        );
        return cached;
    }

    private async writeToCache<T>(key: string, data: T): Promise<void> {
        await this.cacheManager.set(path.join(this.cacheKey, key), data, {
            expires: Date.now() + 5 * 60 * 1000,
        });
    }

    async query(userQuery: string): Promise<GraphRAGResponse> {
        const cacheKey = `query-${userQuery}`;

        // Try to get from cache first
        const cached = await this.readFromCache<GraphRAGResponse>(cacheKey);
        if (cached) {
            return cached;
        }

        // If not in cache, perform the query
        const response = await this.graphRAG.query(userQuery);

        // Cache the result
        await this.writeToCache(cacheKey, response);

        return response;
    }

    async close(): Promise<void> {
        await this.graphRAG.close();
    }

    async createVectorIndex(): Promise<void> {
        try {
            await this.graphRAG.createVectorIndex();
        } catch (error) {
            console.error("Error creating vector index:", error);
            throw error;
        }
    }

    async addDocument(node: {
        id: string;
        title: string;
        content: string;
        connections?: Array<{
            nodeId: string;
            relationType: DocumentRelationType;
            direction: "from" | "to";
        }>;
    }): Promise<void> {
        try {
            await this.graphRAG.addDocument(node);
        } catch (error) {
            console.error("Error adding document:", error);
            throw error;
        }
    }

    async getDocument(id: string): Promise<NodeProperties | null> {
        try {
            return await this.graphRAG.getDocument(id);
        } catch (error) {
            console.error("Error getting document:", error);
            throw error;
        }
    }

    async updateDocument(
        id: string,
        updates: {
            title?: string;
            content?: string;
        }
    ): Promise<void> {
        try {
            await this.graphRAG.updateDocument(id, updates);
        } catch (error) {
            console.error("Error updating document:", error);
            throw error;
        }
    }

    async deleteDocument(id: string): Promise<void> {
        try {
            await this.graphRAG.deleteDocument(id);
        } catch (error) {
            console.error("Error deleting document:", error);
            throw error;
        }
    }

    async addConnection(
        sourceId: string,
        targetId: string,
        relationType: DocumentRelationType
    ): Promise<void> {
        try {
            await this.graphRAG.addConnection(sourceId, targetId, relationType);
        } catch (error) {
            console.error("Error adding connection:", error);
            throw error;
        }
    }

    async deleteConnection(
        sourceId: string,
        targetId: string,
        relationType: DocumentRelationType
    ): Promise<void> {
        try {
            await this.graphRAG.deleteConnection(
                sourceId,
                targetId,
                relationType
            );
        } catch (error) {
            console.error("Error deleting connection:", error);
            throw error;
        }
    }
}

const ragGraphProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string | null> => {
        try {
            const neo4jUri = runtime.getSetting("NEO4J_URI");
            const neo4jUser = runtime.getSetting("NEO4J_USER");
            const neo4jPassword = runtime.getSetting("NEO4J_PASSWORD");

            const provider = new RAGGraphProvider(
                neo4jUri,
                neo4jUser,
                neo4jPassword,
                runtime.cacheManager
            );

            const response = await provider.query(message.content.text);
            await provider.close();

            return response.fullContext;
        } catch (error) {
            console.error("Error in RAG graph provider:", error);
            return null;
        }
    },
};

export { ragGraphProvider };
