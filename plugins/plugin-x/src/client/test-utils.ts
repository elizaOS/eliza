import dotenv from "dotenv";
import { TwitterAuth } from "./auth";
import { EnvAuthProvider } from "./auth-providers/env";
import { Client } from "./client";

// Configure dotenv to read the .env file
dotenv.config();

/**
 * Get authenticated Twitter API v2 client
 * @returns Promise<Client>
 */
export async function getClient(): Promise<Client> {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecretKey = process.env.TWITTER_API_SECRET_KEY;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

  if (!apiKey || !apiSecretKey || !accessToken || !accessTokenSecret) {
    throw new Error(
      "TWITTER_API_KEY, TWITTER_API_SECRET_KEY, TWITTER_ACCESS_TOKEN, and TWITTER_ACCESS_TOKEN_SECRET must be defined.",
    );
  }

  const auth = new TwitterAuth(
    new EnvAuthProvider(undefined, {
      TWITTER_API_KEY: apiKey,
      TWITTER_API_SECRET_KEY: apiSecretKey,
      TWITTER_ACCESS_TOKEN: accessToken,
      TWITTER_ACCESS_TOKEN_SECRET: accessTokenSecret,
    }),
  );
  const loggedIn = await auth.isLoggedIn();

  if (!loggedIn) {
    throw new Error("Failed to authenticate with Twitter API v2");
  }

  const client = new Client();
  client.updateAuth(auth);
  return client;
}
