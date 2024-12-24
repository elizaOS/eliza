import { Driver, Session, Node, Path, Relationship, auth } from "neo4j-driver";
import neo4j from "neo4j-driver";
import { embed } from "ai";
import { openai } from "@ai-sdk/openai";
import GraphRAGError from "./graphRagError";
import {
    SimilarNode,
    NodeProperties,
    GraphRAGResponse,
    DocumentRelationType,
} from "./types";

interface GraphRAGConfig {
    vectorDimension?: number;
    maxDepth?: number;
    similarityThreshold?: number;
    neo4jUri: string;
    neo4jUser: string;
    neo4jPassword: string;
}

export function createGraphRAG(config: GraphRAGConfig) {
    const vectorDimension = config.vectorDimension || 1536;
    const maxDepth = config.maxDepth || 2;
    const similarityThreshold = config.similarityThreshold || 0.7;

    const driver = neo4j.driver(
        config.neo4jUri,
        auth.basic(config.neo4jUser, config.neo4jPassword)
    );
    const session = driver.session();

    async function generateEmbedding(text: string): Promise<number[]> {
        try {
            const { embedding } = await embed({
                model: openai.embedding("text-embedding-ada-002"),
                value: text,
            });
            return embedding;
        } catch (error: any) {
            throw new GraphRAGError(
                `Failed to generate embedding: ${error.message}`,
                "EMBEDDING_GENERATION_FAILED"
            );
        }
    }

    async function semanticSearch(
        query: string,
        limit: number = 5
    ): Promise<SimilarNode[]> {
        try {
            const queryEmbedding = await generateEmbedding(query);

            const result = await session.run(
                `
                CALL db.index.vector.queryNodes('embeddings', $limit, $vector)
                YIELD node, score
                WHERE score >= $threshold
                RETURN node, score
                ORDER BY score DESC
                `,
                {
                    limit,
                    vector: queryEmbedding,
                    threshold: similarityThreshold,
                }
            );

            return result.records.map((record) => ({
                node: record.get("node").properties as NodeProperties,
                score: record.get("score") as number,
            }));
        } catch (error: any) {
            throw new GraphRAGError(
                `Semantic search failed: ${error.message}`,
                "SEMANTIC_SEARCH_FAILED"
            );
        }
    }

    async function graphTraversal(
        seedNodes: SimilarNode[],
        depth: number = maxDepth
    ): Promise<Path[]> {
        try {
            const nodeIds = seedNodes.map((n) => n.node.id);

            const result = await session.run(
                `
                MATCH path = (start)-[*1..${depth}]-(related)
                WHERE id(start) IN $nodeIds
                RETURN path
                `,
                { nodeIds }
            );

            return result.records.map((record) => record.get("path") as Path);
        } catch (error: any) {
            throw new GraphRAGError(
                `Graph traversal failed: ${error.message}`,
                "GRAPH_TRAVERSAL_FAILED"
            );
        }
    }

    function formatPath(path: Path): string {
        return path.segments
            .map((segment) => {
                const start = segment.start as Node;
                const relationship = segment.relationship as Relationship;
                const end = segment.end as Node;

                return `${start.properties.content} -[${relationship.type}]-> ${end.properties.content}`;
            })
            .join("\n");
    }

    function formatContext(
        similarNodes: SimilarNode[],
        contextNodes: Path[]
    ): string {
        const vectorContext = similarNodes
            .map((n) => n.node.content)
            .join("\n\n");

        const graphContext = contextNodes
            .map((path) => formatPath(path))
            .join("\n");

        return `${vectorContext}\n\nRelated Information:\n${graphContext}`;
    }

    async function query(userQuery: string): Promise<GraphRAGResponse> {
        try {
            const similarNodes = await semanticSearch(userQuery);
            const contextNodes = await graphTraversal(similarNodes);
            const context = formatContext(similarNodes, contextNodes);

            return {
                fullContext: context,
                sources: similarNodes,
                relatedContext: contextNodes,
                confidence: similarNodes[0]?.score,
            };
        } catch (error: any) {
            if (error instanceof GraphRAGError) {
                throw error;
            }
            throw new GraphRAGError(
                `Query failed: ${error.message}`,
                "QUERY_FAILED"
            );
        }
    }

    async function close(): Promise<void> {
        await session.close();
        await driver.close();
    }

    async function createVectorIndex(): Promise<void> {
        try {
            await session.run(`
                CREATE VECTOR INDEX embeddings IF NOT EXISTS
                FOR (n:Document)
                ON (n.embedding)
                OPTIONS {
                    indexConfig: {
                        \`vector.dimensions\`: ${vectorDimension},
                        \`vector.similarity_function\`: 'cosine'
                    }
                }
            `);

            await new Promise((resolve) => setTimeout(resolve, 1000));
            console.log("Vector index created successfully!");
        } catch (error: any) {
            throw new GraphRAGError(
                `Failed to create vector index: ${error.message}`,
                "INDEX_CREATION_FAILED"
            );
        }
    }

    async function addDocument(node: {
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
            const embedding = await generateEmbedding(node.content);

            await session.run(
                `
                CREATE (n:Document {
                    id: $id,
                    title: $title,
                    content: $content,
                    embedding: $embedding
                })
                `,
                {
                    id: node.id,
                    title: node.title,
                    content: node.content,
                    embedding: embedding,
                }
            );

            if (node.connections && node.connections.length > 0) {
                for (const connection of node.connections) {
                    const query =
                        connection.direction === "from"
                            ? `
                            MATCH (a:Document {id: $otherId}), (b:Document {id: $currentId})
                            CREATE (a)-[:RELATES_TO {type: $relationType}]->(b)
                            `
                            : `
                            MATCH (a:Document {id: $currentId}), (b:Document {id: $otherId})
                            CREATE (a)-[:RELATES_TO {type: $relationType}]->(b)
                            `;

                    await session.run(query, {
                        currentId: node.id,
                        otherId: connection.nodeId,
                        relationType: connection.relationType,
                    });
                }
            }

            console.log("Document added successfully with connections!");
        } catch (error) {
            throw new GraphRAGError(
                `Failed to add document: ${error}`,
                "DOCUMENT_CREATION_FAILED"
            );
        }
    }

    async function getDocument(id: string): Promise<NodeProperties | null> {
        try {
            const result = await session.run(
                `
                MATCH (n:Document {id: $id})
                RETURN n
                `,
                { id }
            );

            return result.records[0]?.get("n").properties || null;
        } catch (error: any) {
            throw new GraphRAGError(
                `Failed to get document: ${error.message}`,
                "DOCUMENT_FETCH_FAILED"
            );
        }
    }

    async function deleteDocument(id: string): Promise<void> {
        try {
            await session.run(
                `
                MATCH (n:Document {id: $id})
                DETACH DELETE n
                `,
                { id }
            );
        } catch (error: any) {
            throw new GraphRAGError(
                `Failed to delete document: ${error.message}`,
                "DOCUMENT_DELETE_FAILED"
            );
        }
    }

    async function updateDocument(
        id: string,
        updates: {
            title?: string;
            content?: string;
        }
    ): Promise<void> {
        try {
            let embedding;
            if (updates.content) {
                embedding = await generateEmbedding(updates.content);
            }

            const setClause = [
                updates.title ? "n.title = $title" : null,
                updates.content ? "n.content = $content" : null,
                embedding ? "n.embedding = $embedding" : null,
            ]
                .filter(Boolean)
                .join(", ");

            await session.run(
                `
                MATCH (n:Document {id: $id})
                SET ${setClause}
                `,
                {
                    id,
                    ...updates,
                    embedding,
                }
            );
        } catch (error: any) {
            throw new GraphRAGError(
                `Failed to update document: ${error.message}`,
                "DOCUMENT_UPDATE_FAILED"
            );
        }
    }

    async function addConnection(
        sourceId: string,
        targetId: string,
        relationType: DocumentRelationType
    ): Promise<void> {
        try {
            await session.run(
                `
                MATCH (a:Document {id: $sourceId}), (b:Document {id: $targetId})
                CREATE (a)-[:RELATES_TO {type: $relationType}]->(b)
                `,
                { sourceId, targetId, relationType }
            );
        } catch (error: any) {
            throw new GraphRAGError(
                `Failed to add connection: ${error.message}`,
                "CONNECTION_CREATE_FAILED"
            );
        }
    }

    async function deleteConnection(
        sourceId: string,
        targetId: string,
        relationType: DocumentRelationType
    ): Promise<void> {
        try {
            await session.run(
                `
                MATCH (a:Document {id: $sourceId})-[r:RELATES_TO {type: $relationType}]->(b:Document {id: $targetId})
                DELETE r
                `,
                { sourceId, targetId, relationType }
            );
        } catch (error: any) {
            throw new GraphRAGError(
                `Failed to delete connection: ${error.message}`,
                "CONNECTION_DELETE_FAILED"
            );
        }
    }

    return {
        query,
        close,
        createVectorIndex,
        addDocument,
        getDocument,
        deleteDocument,
        updateDocument,
        addConnection,
        deleteConnection,
    };
}
