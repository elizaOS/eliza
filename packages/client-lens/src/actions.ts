import type { LensClient } from "./client";
import {
    elizaLogger,
    type Content,
    type IAgentRuntime,
    type Memory,
    type UUID,
} from "@elizaos/core";
import { textOnly } from "@lens-protocol/metadata";
import { createPublicationMemory } from "./memory";
import { AnyPublicationFragment } from "@lens-protocol/client";
import { StorageProvider } from "./providers/StorageProvider";

export async function sendPublication({
    client,
    runtime,
    content,
    roomId,
    commentOn,
    storage,
}: {
    client: LensClient;
    runtime: IAgentRuntime;
    content: Content;
    roomId: UUID;
    commentOn?: string;
    storage: StorageProvider;
}): Promise<{ memory?: Memory; publication?: AnyPublicationFragment }> {
    const metadata = textOnly({ content: content.text });
    let contentURI;

    try {
        const response = await storage.uploadJson(metadata);
        contentURI = response.url;
    } catch (e) {
        elizaLogger.warn(
            `Failed to upload metadata with storage provider: ${storage.provider}. Ensure your storage provider is configured correctly.`
        );
        throw e;
    }

    const publication = await client.createPublication(
        contentURI,
        false, // TODO: support collectable settings
        commentOn
    );

    if (publication) {
        return {
            publication,
            memory: createPublicationMemory({
                roomId,
                runtime,
                publication: publication as AnyPublicationFragment,
            }),
        };
    }

    return {};
}
