import type { LensClient } from "./client";
import type {
    Content,
    IAgentRuntime,
    Memory,
    UUID,
} from "@elizaos/core";
import { textOnly } from "@lens-protocol/metadata";
import { createPublicationMemory } from "./memory";
import type { AnyPublicationFragment } from "@lens-protocol/client";
import type StorjProvider from "./providers/StorjProvider";

export async function sendPublication({
    client,
    runtime,
    content,
    roomId,
    commentOn,
    ipfs,
}: {
    client: LensClient;
    runtime: IAgentRuntime;
    content: Content;
    roomId: UUID;
    commentOn?: string;
    ipfs: StorjProvider;
}): Promise<{ memory?: Memory; publication?: AnyPublicationFragment }> {
    // TODO: arweave provider for content hosting
    const metadata = textOnly({ content: content.text });
    const contentURI = await ipfs.pinJson(metadata);

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
