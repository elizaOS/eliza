import axios, { AxiosResponse } from 'axios';
import elizaLogger from "./logger.ts";

interface MemeStruct {
  Owner: string;
  ID: string;
  Message: string;
}

class Client {
  private baseUrl: string;

  constructor(baseUrl: string) {
    console.log("Initializing Membase HubClient");
    this.baseUrl = baseUrl;
  }

  async upload(owner: string, filename: string, msg: string): Promise<any> {
    try {
      // Create the meme structure as an object
      const memeStruct: MemeStruct = {
        Owner: owner,
        ID: filename,
        Message: msg
      };

      // Serialize the meme structure to JSON
      const memeStructJson = JSON.stringify(memeStruct);

      // Set the headers for the request
      const headers = {
        'Content-Type': 'application/json'
      };

      // Send the POST request to the API
      const response: AxiosResponse = await axios.post(
        `${this.baseUrl}/api/upload`,
        memeStructJson,
        { headers }
      );

      // Log the upload completion
      elizaLogger.info("Upload done", JSON.stringify(response.data));

      // Optionally return the response if needed
      return response.data;

    } catch (err) {
      elizaLogger.error("Error during upload: ", err);
      return null;
    }
  }
}

const hubEndpoint = process.env.MEMBASE_HUB_ENDPOINT || 'http://54.151.130.2:8080';
export const membaseHub = new Client(hubEndpoint);
export default membaseHub;