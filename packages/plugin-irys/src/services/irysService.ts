import {
    IAgentRuntime,
    Service,
    ServiceType,
    IIrysService,
    UploadIrysResult,
    DataIrysFetchedFromGQL,
} from "@elizaos/core";
import { Uploader } from "@irys/upload";
import { BaseEth } from "@irys/upload-ethereum";
import { GraphQLClient, gql } from 'graphql-request';

interface TransactionsId {
    success: boolean;
    transactions: string[];
    error?: string;
}

interface TransactionGQL {
    transactions: {
        edges: {
            node: {
                id: string;
            }
        }[]
    }
}

export class IrysService extends Service implements IIrysService {
    static serviceType: ServiceType = ServiceType.IRYS;

    private runtime: IAgentRuntime | null = null;
    private irysUploader: any | null = null;
    private endpointForTransactionId: string = "https://uploader.irys.xyz/graphql";
    private endpointForData: string = "https://gateway.irys.xyz";

    async initialize(runtime: IAgentRuntime): Promise<void> {
        console.log("Initializing IrysService");
        this.runtime = runtime;
    }

    private async getTransactionId(owners: string[]): Promise<TransactionsId> {
        const graphQLClient = new GraphQLClient(this.endpointForTransactionId);
        const QUERY = gql`
            query($owners: [String!]) {
                transactions(owners: $owners) {
                    edges {
                        node {
                            id
                        }
                    }
                }
            }
        `;
        try {
            const variables = {
                owners: owners,
            }
            const data: TransactionGQL = await graphQLClient.request(QUERY, variables);
            const transactionIds = data.transactions.edges.map((edge: any) => edge.node.id);
            console.log("Transaction IDs retrieved")
            return { success: true, transactions: transactionIds };
        } catch (error) {
            console.error("Error fetching transaction IDs", error);
            return { success: false, transactions: [], error: "Error fetching transaction IDs" };
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
        if (!response.ok) return { success: false, data: null, error: "Error fetching data from transaction ID" };
        return {
            success: true,
            data: response,
        };
    }

    async uploadDataOnIrys(data: any): Promise<UploadIrysResult> {
        if (!(await this.initializeIrysUploader())) {
            return {
                success: false,
                error: "Irys uploader not initialized",
            };
        }

        try {
            const dataToStore = {
                data: data,
                timestamp: new Date().toISOString()
            };

            const receipt = await this.irysUploader.upload(JSON.stringify(dataToStore));
            return { success: true, url: `https://gateway.irys.xyz/${receipt.id}` };
        } catch (error) {
            return { success: false, error: "Error uploading to Irys, " + error };
        }
    }

    async uploadFileOrImageOnIrys(data: string): Promise<UploadIrysResult> {
        if (!(await this.initializeIrysUploader())) {
            return {
                success: false,
                error: "Irys uploader not initialized"
            };
        }

        try {
            const receipt = await this.irysUploader.uploadFile(data);
            return { success: true, url: `https://gateway.irys.xyz/${receipt.id}` };
        } catch (error) {
            return { success: false, error: "Error uploading to Irys, " + error };
        }
    }

    async getDataFromAnAgent(agentsWalletPublicKeys: string[]): Promise<DataIrysFetchedFromGQL> {
        try {
            const transactionIdsResponse = await this.getTransactionId(agentsWalletPublicKeys);
            if (!transactionIdsResponse.success) return { success: false, data: null, error: "Error fetching transaction IDs" };
            const transactionIds = transactionIdsResponse.transactions;
            const dataPromises: Promise<any>[] = transactionIds.map(async (id) => {
                const fetchDataFromTransactionIdResponse = await this.fetchDataFromTransactionId(id);
                if (await fetchDataFromTransactionIdResponse.data.headers.get('content-type') == "application/octet-stream") {
                    let data = null;
                    try {
                        data = await fetchDataFromTransactionIdResponse.data.json();
                    } catch (error) {
                        try {
                            data = await fetchDataFromTransactionIdResponse.data.text();
                        } catch (error) {
                            console.log("Error fetching data from transaction ID, ", error);
                        }
                    }
                    return data;
                }
                else if (await fetchDataFromTransactionIdResponse.data.headers.get('content-type').includes("image")) {
                    return fetchDataFromTransactionIdResponse.data.url;
                }
            });
            const data = await Promise.all(dataPromises);
            return { success: true, data: data };
        } catch (error) {
            return { success: false, data: null, error: "Error fetching data from transaction IDs " + error };
        }
    }
}

export default IrysService;