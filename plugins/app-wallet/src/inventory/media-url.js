/**
 * Normalize NFT/token image URLs for browser rendering.
 * Wallet APIs often return ipfs://, ipns://, or ar:// URIs that <img> cannot load directly.
 */
const IPFS_GATEWAY_BASE = "https://ipfs.io/ipfs/";
const IPNS_GATEWAY_BASE = "https://ipfs.io/ipns/";
const ARWEAVE_GATEWAY_BASE = "https://arweave.net/";
export function normalizeInventoryImageUrl(raw) {
    const value = raw?.trim();
    if (!value)
        return null;
    if (/^(?:https?:|data:image\/|blob:)/i.test(value)) {
        return value;
    }
    if (/^ipfs:\/\//i.test(value)) {
        const cidPath = value.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
        return cidPath ? `${IPFS_GATEWAY_BASE}${cidPath}` : null;
    }
    if (/^ipns:\/\//i.test(value)) {
        const namePath = value.replace(/^ipns:\/\//i, "");
        return namePath ? `${IPNS_GATEWAY_BASE}${namePath}` : null;
    }
    if (/^ar:\/\//i.test(value)) {
        const txId = value.replace(/^ar:\/\//i, "");
        return txId ? `${ARWEAVE_GATEWAY_BASE}${txId}` : null;
    }
    return null;
}
