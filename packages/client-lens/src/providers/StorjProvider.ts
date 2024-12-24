import axios, { AxiosInstance } from "axios";
import FormData from "form-data";
import { elizaLogger, type IAgentRuntime } from "@elizaos/core";
import {
    StorageProvider,
    StorageProviderEnum,
    UploadResponse,
} from "./StorageProvider";

// ipfs pinning service: https://storj.dev/dcs/api/storj-ipfs-pinning
export class StorjProvider implements StorageProvider {
    provider = StorageProviderEnum.STORJ;
    private STORJ_API_URL: string = "https://www.storj-ipfs.com";
    private STORJ_API_USERNAME: string;
    private STORJ_API_PASSWORD: string;
    private baseURL: string;
    private client: AxiosInstance;

    constructor(runtime: IAgentRuntime) {
        this.STORJ_API_USERNAME = runtime.getSetting("STORJ_API_USERNAME")!;
        this.STORJ_API_PASSWORD = runtime.getSetting("STORJ_API_PASSWORD")!;
        if (!this.STORJ_API_USERNAME || !this.STORJ_API_PASSWORD) {
            elizaLogger.warn(
                "To use Storj ipfs pinning service you need to set STORJ_API_USERNAME or STORJ_API_PASSWORD in envornment variables. Get your keys at https://storj.io"
            );
        }
        this.baseURL = `${this.STORJ_API_URL}/api/v0`;
        this.client = this.createClient();
    }

    private createClient(): AxiosInstance {
        return axios.create({
            baseURL: this.baseURL,
            auth: {
                username: this.STORJ_API_USERNAME,
                password: this.STORJ_API_PASSWORD,
            },
        });
    }

    private hash(uriOrHash: string): string {
        return typeof uriOrHash === "string" && uriOrHash.startsWith("ipfs://")
            ? uriOrHash.split("ipfs://")[1]
            : uriOrHash;
    }

    public gatewayURL(uriOrHash: string): string {
        return `${this.STORJ_API_URL}/ipfs/${this.hash(uriOrHash)}`;
    }

    public async uploadJson(
        uploadData: Record<string, any> | string
    ): Promise<UploadResponse> {
        const stringifiedData =
            typeof uploadData === "string"
                ? uploadData
                : JSON.stringify(uploadData);
        const formData = new FormData();

        formData.append(
            "path",
            Buffer.from(stringifiedData, "utf-8").toString()
        );

        const headers = {
            "Content-Type": "multipart/form-data",
            ...formData.getHeaders(),
        };

        const { data } = await this.client.post(
            "add?cid-version=1",
            formData.getBuffer(),
            { headers }
        );

        return {
            url: this.gatewayURL(data.Hash),
            cid: data.Hash,
        };
    }

    public async uploadFile(file: {
        buffer: Buffer;
        originalname: string;
        mimetype: string;
    }): Promise<UploadResponse> {
        const formData = new FormData();
        formData.append("file", file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype,
        });

        const response = await this.client.post("add?cid-version=1", formData, {
            headers: {
                "Content-Type": `multipart/form-data; boundary=${formData.getBoundary()}`,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        return {
            url: this.gatewayURL(response.data.Hash),
            cid: response.data.Hash,
        };
    }
}
