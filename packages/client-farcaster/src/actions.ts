import type { FarcasterClient } from "./client";
import type { Content, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { Cast, CastId, Profile } from "./types";
import { createCastMemory } from "./memory";
import { splitPostContent } from "./utils";

export async function sendCast({
    client,
    runtime,
    content,
    roomId,
    inReplyTo,
    profile,
}: {
    profile: Profile;
    client: FarcasterClient;
    runtime: IAgentRuntime;
    content: Content;
    roomId: UUID;
    signerUuid: string;
    inReplyTo?: CastId;
}): Promise<{ memory: Memory; cast: Cast }[]> {
    const chunks = splitPostContent(content.text);
    const sent: Cast[] = [];
    let parentCastId = inReplyTo;

    for (const chunk of chunks) {
        const neynarCast = await client.publishCast(chunk, parentCastId);

        if (neynarCast) {
            const cast: Cast = {
                hash: neynarCast.hash,
                authorFid: neynarCast.authorFid,
                text: neynarCast.text,
                profile,
                inReplyTo: parentCastId,
                timestamp: new Date(),
            };

            sent.push(cast!);

            parentCastId = {
                fid: neynarCast.authorFid!,
                hash: neynarCast.hash!,
            };
        }
    }

    return sent.map((cast) => ({
        cast,
        memory: createCastMemory({
            roomId,
            senderId: runtime.agentId,
            runtime,
            cast,
        }),
    }));
}
