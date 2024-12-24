import { z } from "zod";
import { Content } from "@elizaos/core";


export interface MintNFTContent extends Content {
    collectionAddress: string;
}

export const MintNFTSchema = z.object({
    collectionAddress: z.string(),
});
