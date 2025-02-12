export type MediaData = {
    data: Buffer;
    mediaType: string;
};

export interface ActionResponse {
    like: boolean;
    retweet: boolean;
    quote?: boolean;
    reply?: boolean;
}

export enum ActionTimelineType {
    ForYou = "foryou",
    Following = "following",
}