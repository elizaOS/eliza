import { z } from "zod";

export interface TweetContent {
    text: string;
}

export const TweetSchema = z.object({
    text: z.string().describe("The text of the tweet"),
});

export const isTweetContent = (obj: unknown): obj is TweetContent => {
    return TweetSchema.safeParse(obj).success;
};
