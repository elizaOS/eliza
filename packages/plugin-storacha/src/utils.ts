import { Memory } from '@elizaos/core';
import { CID } from 'multiformats/cid';
import { CarReader } from '@ipld/car';
import { importDAG } from '@ucanto/core/delegation';

export const defaultGatewayUrl = "https://w3s.link";

export const getCIDsFromMessage = (message: Memory) => {

    // General pattern to match potential CIDs
    const cidPattern = /[a-zA-Z0-9]+/g;
    const matches = message.content.text.match(cidPattern);
    const cids: string[] = [];
    if (matches) {
        for (const match of matches) {
            try {
                const cid = CID.parse(match);
                if (cid.version === 1) {
                    cids.push(cid.toString());
                }
            } catch (error) {
                // Not a valid CID
            }
        }
    }
    return cids;
}


/**
 * Parses a delegation from a base64 encoded CAR file
 * @param data - The base64 encoded CAR file
 * @returns The parsed delegation
 */
export const parseDelegation = async (data: string) => {
    const blocks = []
    const reader = await CarReader.fromBytes(Buffer.from(data, 'base64'))
    for await (const block of reader.blocks()) {
        blocks.push(block)
    }
    return importDAG(blocks)
}
