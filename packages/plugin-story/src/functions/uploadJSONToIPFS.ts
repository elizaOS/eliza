import type PinataClient from "@pinata/sdk";

export async function uploadJSONToIPFS(
    pinata: PinataClient,
    jsonMetadata: Record<string, unknown>  // Replaced any with Record<string, unknown>
): Promise<string> {
    const { IpfsHash } = await pinata.pinJSONToIPFS(jsonMetadata);
    return IpfsHash;
}
