import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
    AssetWithProof,
    burn,
    cancelRedeem,
    decompressV1,
    findLeafAssetIdPda,
    findVoucherPda,
    getAssetWithProof,
    mplBubblegum,
    redeem,
    transfer,
    UpdateArgsArgs,
    delegate,
    updateMetadata,
    mintV1,
    MetadataArgsArgs,
} from "@metaplex-foundation/mpl-bubblegum";

import {
    generateSigner,
    Keypair,
    keypairIdentity,
    PublicKey,
    RpcConfirmTransactionResult,
    some,
    TransactionSignature,
    Umi,
} from "@metaplex-foundation/umi";
import {
    dasApi,
    DasApiAsset,
    DasApiAssetList,
    DasApiInterface,
    DasApiPropGroupKey,
    GetAssetProofRpcResponse,
} from "@metaplex-foundation/digital-asset-standard-api";
import { base58 } from "@metaplex-foundation/umi/serializers";
import { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { getWalletKey } from "../utils";
import { validateMplBubblegumConfig } from "../environment";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";

export type Signature = string;

export class MplBubblegumProvider {
    private readonly umi: Umi & { rpc: DasApiInterface };
    private readonly keypair?: Keypair;

    constructor(rpcUrl: string, keypair?: Keypair) {
        const umi = createUmi(rpcUrl)
            .use(keypair ? keypairIdentity(keypair) : undefined)
            .use(mplBubblegum())
            .use(dasApi());

        this.umi = umi as Umi & { rpc: DasApiInterface };
        this.keypair = keypair;
    }

    private ensureKeypairIsSet(): void {
        if (!this.keypair) {
            throw new Error("This operation requires a keypair.");
        }
    }

    public getKeypairPublicKey(): PublicKey {
        this.ensureKeypairIsSet();
        return this.keypair.publicKey;
    }

    public findLeafAssetId(
        merkleTree: PublicKey,
        leafIndex: number
    ): [PublicKey, number] {
        const [assetId, bump] = findLeafAssetIdPda(this.umi, {
            merkleTree: merkleTree,
            leafIndex,
        });

        return [assetId, bump];
    }

    public async getAsset(assetId: PublicKey): Promise<DasApiAsset> {
        const rpcAsset = await this.umi.rpc.getAsset(assetId);
        return rpcAsset;
    }

    public async getAssetProof(
        assetId: PublicKey
    ): Promise<GetAssetProofRpcResponse> {
        const rpcAssetProof = await this.umi.rpc.getAssetProof(assetId);
        return rpcAssetProof;
    }

    public async getAssetWithProof(
        assetId: PublicKey
    ): Promise<AssetWithProof> {
        const assetWithProof = await getAssetWithProof(this.umi, assetId);
        return assetWithProof;
    }

    public async getAssetsByOwner(owner: PublicKey): Promise<DasApiAssetList> {
        const rpcAssetList = await this.umi.rpc.getAssetsByOwner({ owner });
        return rpcAssetList;
    }

    public async getAssetsByGroup(
        groupKey: DasApiPropGroupKey,
        groupValue: string
    ): Promise<DasApiAssetList> {
        const rpcAssetList = await this.umi.rpc.getAssetsByGroup({
            groupKey,
            groupValue,
        });
        return rpcAssetList;
    }

    public async mint({
        merkleTree,
        leafOwner,
        metadata,
    }: {
        merkleTree: PublicKey;
        leafOwner?: PublicKey;
        metadata: MetadataArgsArgs;
    }): Promise<{
        signature: TransactionSignature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const { signature, result } = await mintV1(this.umi, {
            merkleTree,
            leafOwner: leafOwner || this.keypair.publicKey,
            metadata,
        }).sendAndConfirm(this.umi);

        return { signature, result };
    }

    public async transfer(
        assetId: PublicKey,
        newLeafOwner: PublicKey
    ): Promise<{
        signature: Signature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const assetWithProof = await this.getAssetWithProof(assetId);
        const { signature, result } = await transfer(this.umi, {
            ...assetWithProof,
            leafOwner: this.keypair.publicKey,
            newLeafOwner,
        }).sendAndConfirm(this.umi);

        return { signature: base58.deserialize(signature)[0], result };
    }

    public async updateMetadata(
        assetId: PublicKey,
        collectionMint?: PublicKey,
        name?: string,
        uri?: string
    ): Promise<{
        signature: Signature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const assetWithProof = await this.getAssetWithProof(assetId);

        const updateArgs: UpdateArgsArgs = {
            name: some(name),
            uri: some(uri),
        };

        const { signature, result } = await updateMetadata(this.umi, {
            ...assetWithProof,
            leafOwner: this.keypair.publicKey,
            currentMetadata: assetWithProof.metadata,
            updateArgs,
            collectionMint: collectionMint,
        }).sendAndConfirm(this.umi);

        return { signature: base58.deserialize(signature)[0], result };
    }

    public async burn(assetId: PublicKey): Promise<{
        signature: Signature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const assetWithProof = await this.getAssetWithProof(assetId);

        const { signature, result } = await burn(this.umi, {
            ...assetWithProof,
            leafOwner: this.keypair.publicKey,
        }).sendAndConfirm(this.umi);

        return { signature: base58.deserialize(signature)[0], result };
    }

    public async redeem(assetId: PublicKey): Promise<{
        signature: Signature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const assetWithProof = await this.getAssetWithProof(assetId);

        const signer = generateSigner(this.umi);

        const { signature, result } = await redeem(this.umi, {
            ...assetWithProof,
            leafOwner: signer,
        }).sendAndConfirm(this.umi);

        return { signature: base58.deserialize(signature)[0], result };
    }

    public async decompress(assetId: PublicKey): Promise<{
        signature: Signature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const assetWithProof = await this.getAssetWithProof(assetId);

        const signer = generateSigner(this.umi);

        const { signature, result } = await decompressV1(this.umi, {
            ...assetWithProof,
            leafOwner: signer,
            mint: assetId,
            voucher: findVoucherPda(this.umi, assetWithProof),
        }).sendAndConfirm(this.umi);

        return { signature: base58.deserialize(signature)[0], result };
    }

    public async cancelRedeem(assetId: PublicKey): Promise<{
        signature: Signature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const assetWithProof = await this.getAssetWithProof(assetId);

        const signer = generateSigner(this.umi);

        const { signature, result } = await cancelRedeem(this.umi, {
            ...assetWithProof,
            leafOwner: signer,
            voucher: findVoucherPda(this.umi, assetWithProof),
        }).sendAndConfirm(this.umi);

        return { signature: base58.deserialize(signature)[0], result };
    }

    public async delegateAsset(
        assetId: PublicKey,
        newDelegate: PublicKey
    ): Promise<{
        signature: Signature;
        result: RpcConfirmTransactionResult;
    }> {
        this.ensureKeypairIsSet();
        const assetWithProof = await this.getAssetWithProof(assetId);

        const signer = generateSigner(this.umi);

        const { signature, result } = await delegate(this.umi, {
            ...assetWithProof,
            leafOwner: signer,
            previousLeafDelegate: this.keypair.publicKey,
            newLeafDelegate: newDelegate,
        }).sendAndConfirm(this.umi);

        return { signature: base58.deserialize(signature)[0], result };
    }
}
