import {
    type IAgentRuntime,
    Service,
    ServiceType,
    type IIrysService,
    type UploadIrysResult,
    type DataIrysFetchedFromGQL,
    type GraphQLTag,
    IrysMessageType,
    generateMessageResponse,
    ModelClass,
    IrysDataType,
    type IrysTimestamp,
} from "@elizaos/core";
import { Uploader } from "@irys/upload";
import { BaseEth } from "@irys/upload-ethereum";
import { GraphQLClient, gql } from 'graphql-request';
import crypto from 'node:crypto';

interface NodeGQL {
    id: string;
    address: string;
}

interface TransactionsIdAddress {
    success: boolean;
    data: NodeGQL[];
    error?: string;
}

interface TransactionEdge {
    node: {
        id: string;
        address: string;
    }
}

interface TransactionGQL {
    transactions: {
        edges: TransactionEdge[]
    }
}

interface IrysUploader {
    upload: (data: string, options: { tags: { name: string; value: string }[] }) => Promise<{ id: string }>;
    uploadFile: (data: string, options: { tags: { name: string; value: string }[] }) => Promise<{ id: string }>;
}

interface IrysDataNode {
    data: string;
    address: string;
}

class IrysService extends Service implements IIrysService {
    static serviceType: ServiceType = ServiceType.IRYS;

    private runtime: IAgentRuntime | null = null;
    private irysUploader: IrysUploader | null = null;
    private endpointForTransactionId = "https://uploader.irys.xyz/graphql";
    private endpointForData = "https://gateway.irys.xyz";

    async initialize(runtime: IAgentRuntime): Promise<void> {
        console.log("Initializing IrysService");
        this.runtime = runtime;
    }

    private async getTransactionId(owners: string[] = null, tags: GraphQLTag[] = null, timestamp: IrysTimestamp = null): Promise<TransactionsIdAddress> {
        const graphQLClient = new GraphQLClient(this.endpointForTransactionId);
        const QUERY = gql`
            query($owners: [String!], $tags: [TagFilter!], $timestamp: TimestampFilter) {
                transactions(owners: $owners, tags: $tags, timestamp: $timestamp) {
                    edges {
                        node {
                            id,
                            address
                        }
                    }
                }
            }
        `;
        try {
            const variables = {
                owners: owners,
                tags: tags,
                timestamp: timestamp
            }
            const data: TransactionGQL = await graphQLClient.request(QUERY, variables);
            const listOfTransactions : NodeGQL[] = data.transactions.edges.map((edge: TransactionEdge) => edge.node);
            console.log("Transaction IDs retrieved")
            return { success: true, data: listOfTransactions };
        } catch (error) {
            console.error("Error fetching transaction IDs", error);
            return { success: false, data: [], error: "Error fetching transaction IDs" };
        }
    }

    private async initializeIrysUploader(): Promise<boolean> {
        if (this.irysUploader) return true;
        if (!this.runtime) return false;

        try {
            const EVM_WALLET_PRIVATE_KEY = this.runtime.getSetting("EVM_WALLET_PRIVATE_KEY");
            if (!EVM_WALLET_PRIVATE_KEY) return false;

            const irysUploader = await Uploader(BaseEth).withWallet(EVM_WALLET_PRIVATE_KEY);
            this.irysUploader = irysUploader;
            return true;
        } catch (error) {
            console.error("Error initializing Irys uploader:", error);
            return false;
        }
    }

    private async fetchDataFromTransactionId(transactionId: string): Promise<DataIrysFetchedFromGQL> {
        console.log(`Fetching data from transaction ID: ${transactionId}`);
        const response = await fetch(`${this.endpointForData}/${transactionId}`);
        if (!response.ok) {
            return { success: false, data: null, error: "Error fetching data from transaction ID" };
        }
        return {
            success: true,
            data: response,
        };
    }
    private converToValues(value: unknown): string[] {
        if (Array.isArray(value)) {
            return value.map(String);
        }
        return [String(value)];
    }

    private async orchestrateRequest(requestMessage: string, tags: GraphQLTag[], timestamp: IrysTimestamp = null): Promise<DataIrysFetchedFromGQL> {
        const serviceCategory = tags.find((tag) => tag.name === "Service-Category")?.values;
        const protocol = tags.find((tag) => tag.name === "Protocol")?.values;
        const minimumProviders = Number(tags.find((tag) => tag.name === "Minimum-Providers")?.values);
        /*
            Further implementation of the orchestrator
            { name: "Validation-Threshold", values: validationThreshold },
            { name: "Test-Provider", values: testProvider },
            { name: "Reputation", values: reputation },
        */
        const tagsToRetrieve : GraphQLTag[] = [
            { name: "Message-Type", values: [IrysMessageType.DATA_STORAGE] },
            { name: "Service-Category", values: this.converToValues(serviceCategory) },
            { name: "Protocol", values: this.converToValues(protocol) },
        ];
        const data = await this.getDataFromAnAgent(null, tagsToRetrieve, timestamp);
        if (!data.success) {
            return { success: false, data: null, error: data.error };
        }
        const dataArray = data.data as IrysDataNode[];
        
        for (let i = 0; i < dataArray.length; i++) {
            try {
                const node = dataArray[i];
                const templateRequest = `
                Determine the truthfulness of the relationship between the given context and text.
                Context: ${requestMessage}
                Text: ${node.data}
                Return True or False
                `;
                const responseFromModel = await generateMessageResponse({
                    runtime: this.runtime,
                    context: templateRequest,
                    modelClass: ModelClass.MEDIUM,
                });
                console.log("RESPONSE FROM MODEL : ", responseFromModel);
                if (!responseFromModel.success || (responseFromModel.content?.toString().toLowerCase().includes('false') && !responseFromModel.content?.toString().toLowerCase().includes('true'))) {
                    dataArray.splice(i, 1);
                    i--;
                }
            } catch (error: unknown) {
                if (error instanceof Error && error.message.includes("TypeError: Cannot read properties of undefined (reading 'settings')")) {
                    return { success: false, data: null, error: "Error in the orchestrator" };
                }
                throw error;
            }
        }
        const responseTags: GraphQLTag[] = [
            { name: "Message-Type", values: [IrysMessageType.REQUEST_RESPONSE] },
            { name: "Service-Category", values: [serviceCategory] },
            { name: "Protocol", values: [protocol] },
            { name: "Request-Id", values: [tags.find((tag) => tag.name === "Request-Id")?.values[0]] },
        ];
        if (dataArray.length === 0) {
            const response = await this.uploadDataOnIrys("No relevant data found from providers", responseTags, IrysMessageType.REQUEST_RESPONSE);
            console.log("Response from Irys: ", response);
            return { success: false, data: null, error: "No relevant data found from providers" };
        }
        const listProviders = new Set(dataArray.map((provider: IrysDataNode) => provider.address));
        if (listProviders.size < minimumProviders) {
            const response = await this.uploadDataOnIrys("Not enough providers", responseTags, IrysMessageType.REQUEST_RESPONSE);
            console.log("Response from Irys: ", response);
            return { success: false, data: null, error: "Not enough providers" };
        }
        const listData = dataArray.map((provider: IrysDataNode) => provider.data);
        const response = await this.uploadDataOnIrys(listData, responseTags, IrysMessageType.REQUEST_RESPONSE);
        console.log("Response from Irys: ", response);
        return {
            success: true,
            data: listData
        }
    }

    // Orchestrator
    private async uploadDataOnIrys(data: unknown, tags: GraphQLTag[], messageType: IrysMessageType, timestamp: IrysTimestamp = null): Promise<UploadIrysResult> {
        if (!(await this.initializeIrysUploader())) {
            return {
                success: false,
                error: "Irys uploader not initialized",
            };
        }

        // Transform tags to the correct format
        const formattedTags = tags.map(tag => ({
            name: tag.name,
            value: Array.isArray(tag.values) ? tag.values.join(',') : tag.values
        }));

        const requestId = String(crypto.createHash('sha256').update(new Date().toISOString()).digest('hex'));
        formattedTags.push({
            name: "Request-Id",
            value: requestId
        });

        try {
            const dataToStore = {
                data: data,
            };
            const receipt = await this.irysUploader.upload(JSON.stringify(dataToStore), { tags: formattedTags });
            if (messageType === IrysMessageType.DATA_STORAGE || messageType === IrysMessageType.REQUEST_RESPONSE) {
                return { success: true, url: `https://gateway.irys.xyz/${receipt.id}`};
            }
            if (messageType === IrysMessageType.REQUEST) {
                const response = await this.orchestrateRequest(data as string, tags, timestamp);
                return {
                    success: response.success,
                    url: `https://gateway.irys.xyz/${receipt.id}`,
                    data: response.data,
                    error: response.error ? response.error : null
                };
            }
            return { success: true, url: `https://gateway.irys.xyz/${receipt.id}` };
        } catch (error) {
            return { success: false, error: `Error uploading to Irys, ${error}` };
        }
    }

    private async uploadFileOrImageOnIrys(data: string, tags: GraphQLTag[]): Promise<UploadIrysResult> {
        if (!(await this.initializeIrysUploader())) {
            return {
                success: false,
                error: "Irys uploader not initialized"
            };
        }

        const formattedTags = tags.map(tag => ({
            name: tag.name,
            value: Array.isArray(tag.values) ? tag.values.join(',') : tag.values
        }));

        try {
            const receipt = await this.irysUploader.uploadFile(data, { tags: formattedTags });
            return { success: true, url: `https://gateway.irys.xyz/${receipt.id}` };
        } catch (error) {
            return { success: false, error: `Error uploading to Irys, ${error}` };
        }
    }

    private normalizeArrayValues(arr: number[], min: number, max?: number): void {
        for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.max(min, max !== undefined ? Math.min(arr[i], max) : arr[i]);
        }
    }

    private normalizeArraySize(arr: string[] | number[] | boolean[]): (string | number | boolean)[] {
        if (arr.length === 1) {
            return [arr[0]];
        }
        return arr;
    }

    async workerUploadDataOnIrys(data: unknown, dataType: IrysDataType, messageType: IrysMessageType, serviceCategory: string[], protocol: string[], validationThreshold: number[] = [], minimumProviders: number[] = [], testProvider: boolean[] = [], reputation: number[] = []): Promise<UploadIrysResult> {
        this.normalizeArrayValues(validationThreshold, 0, 1);
        this.normalizeArrayValues(minimumProviders, 0);
        this.normalizeArrayValues(reputation, 0, 1);

        const tags = [
            { name: "Message-Type", values: [messageType] },
            { name: "Service-Category", values: this.normalizeArraySize(serviceCategory) },
            { name: "Protocol", values: this.normalizeArraySize(protocol) },
        ] as GraphQLTag[];

        if (messageType === IrysMessageType.REQUEST) {
            if (validationThreshold.length > 0) {
                tags.push({ name: "Validation-Threshold", values: this.normalizeArraySize(validationThreshold) });
            }
            if (minimumProviders.length > 0) {
                tags.push({ name: "Minimum-Providers", values: this.normalizeArraySize(minimumProviders) });
            }
            if (testProvider.length > 0) {
                tags.push({ name: "Test-Provider", values: this.normalizeArraySize(testProvider) });
            }
            if (reputation.length > 0) {
                tags.push({ name: "Reputation", values: this.normalizeArraySize(reputation) });
            }
        }
        if (dataType === IrysDataType.FILE || dataType === IrysDataType.IMAGE) {
            return await this.uploadFileOrImageOnIrys(data as string, tags);
        }

        return await this.uploadDataOnIrys(data, tags, messageType);
    }

    async providerUploadDataOnIrys(data: unknown, dataType: IrysDataType, serviceCategory: string[], protocol: string[]): Promise<UploadIrysResult> {
        const tags = [
            { name: "Message-Type", values: [IrysMessageType.DATA_STORAGE] },
            { name: "Service-Category", values: serviceCategory },
            { name: "Protocol", values: protocol },
        ] as GraphQLTag[];

        if (dataType === IrysDataType.FILE || dataType === IrysDataType.IMAGE) {
            return await this.uploadFileOrImageOnIrys(data as string, tags);
        }

        return await this.uploadDataOnIrys(data, tags, IrysMessageType.DATA_STORAGE);
    }

    async getDataFromAnAgent(agentsWalletPublicKeys: string[] | null = null, tags: GraphQLTag[] | null = null, timestamp: IrysTimestamp | null = null): Promise<DataIrysFetchedFromGQL> {
        try {
            const transactionIdsResponse = await this.getTransactionId(agentsWalletPublicKeys, tags, timestamp);
            if (!transactionIdsResponse.success) {
                return { success: false, data: null, error: "Error fetching transaction IDs" };
            }
            const transactionIdsAndResponse = transactionIdsResponse.data.map((node: NodeGQL) => node);
            const dataPromises: Promise<{ data: unknown; address: string }>[] = transactionIdsAndResponse.map(async (node: NodeGQL) => {
                const fetchDataFromTransactionIdResponse = await this.fetchDataFromTransactionId(node.id);
                if (await fetchDataFromTransactionIdResponse.data.headers.get('content-type') === "application/octet-stream") {
                    let data = null;
                    const responseText = await fetchDataFromTransactionIdResponse.data.text();
                    try {
                        data = JSON.parse(responseText);
                    } catch {
                        data = responseText;
                    }
                    return {
                        data: data,
                        address: node.address
                    };
                }
                return {
                    data: fetchDataFromTransactionIdResponse.data.url,
                    address: node.address
                };
            });
            const data = await Promise.all(dataPromises);
            return { success: true, data: data };
        } catch (error) {
            return { success: false, data: null, error: `Error fetching data from transaction IDs ${error}` };
        }
    }
}

export default IrysService;