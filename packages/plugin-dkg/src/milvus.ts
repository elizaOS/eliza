import dotenv from "dotenv";
dotenv.config();
import { MilvusClient } from "@zilliz/milvus2-sdk-node";
import axios from "axios";
import { HuggingFaceInferenceEmbeddings } from "@langchain/community/embeddings/hf";
const client = new MilvusClient({
    address: process.env.MILVUS_ADDRESS,
    token: process.env.MILVUS_TOKEN,
});
interface MilvusData {
    [x: string]: number[] | string;
    vector: number[];
    text: string;
    ual: string;
}

const hfModel = new HuggingFaceInferenceEmbeddings({
    apiKey: process.env.HUGGINGFACE_API_KEY,
    model: "guidecare/all-mpnet-base-v2-feature-extraction",
});

export async function getEmbedding(text: string): Promise<number[]> {
    return await hfModel.embedQuery(text);
}
export async function insertData(data: MilvusData[], collectionName: string) {
    await client.insert({ collection_name: collectionName, data: data });
}
export async function searchData(
    collectionName: string,
    data: number[],
    topK: number = 3,
) {
    return await client.search({
        collection_name: collectionName,
        data: [data],
        limit: topK,
    });
}
