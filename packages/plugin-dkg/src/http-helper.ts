import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import path from "path";

const chatDKGAxiosConfig = {
    baseURL: process.env.CHATDKG_API_URL,
    timeout: 180000,
};

if (process.env.CHATDKG_USE_AUTHENTICATION) {
    chatDKGAxiosConfig["auth"] = {
        username: process.env.CHATDKG_USERNAME,
        password: process.env.CHATDKG_PASSWORD,
    };
}

export const chatDKGHttpService = axios.create(chatDKGAxiosConfig);

export async function getSentimentChart(
    score: number,
    cashtag: string,
): Promise<any> {
    try {
        const response = await chatDKGHttpService.post(
            "/server/api/get-sentiment-chart",
            {
                score,
                cashtag,
            },
        );

        return response.data;
    } catch (error) {
        console.error("Error fetching sentiment chart:", error);
        throw error;
    }
}

export async function fetchFileFromUrl(
    fileUrl: string,
): Promise<{ name: string; data: Buffer }> {
    try {
        const response = await axios.get(fileUrl, {
            responseType: "arraybuffer",
        });
        const fileName = path.basename(new URL(fileUrl).pathname);
        return { name: fileName, data: Buffer.from(response.data) };
    } catch (error) {
        console.error("Error fetching file from URL:", error);
        throw error;
    }
}
