import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import {
    type AnyPublicationFragment,
    LensClient as LensClientCore,
    production,
    LensTransactionStatusType,
    LimitType,
    NotificationType,
    type ProfileFragment,
    PublicationType,
    FeedEventItemType,
} from "@lens-protocol/client";
import type { Profile, BroadcastResult } from "./types";
import type { PrivateKeyAccount } from "viem";
import { getProfilePictureUri, handleBroadcastResult, omit } from "./utils";

export class LensClient {
    runtime: IAgentRuntime;
    account: PrivateKeyAccount;
    cache: Map<string, any>;
    lastInteractionTimestamp: Date;
    profileId: `0x${string}`;

    private authenticated: boolean;
    private authenticatedProfile: ProfileFragment | null;
    private core: LensClientCore;

    constructor(opts: {
        runtime: IAgentRuntime;
        cache: Map<string, any>;
        account: PrivateKeyAccount;
        profileId: `0x${string}`;
    }) {
        this.cache = opts.cache;
        this.runtime = opts.runtime;
        this.account = opts.account;
        this.core = new LensClientCore({
            environment: production,
        });
        this.lastInteractionTimestamp = new Date();
        this.profileId = opts.profileId;
        this.authenticated = false;
        this.authenticatedProfile = null;
    }

    async authenticate(): Promise<void> {
        try {
            const { id, text } =
                await this.core.authentication.generateChallenge({
                    signedBy: this.account.address,
                    for: this.profileId,
                });

            const signature = await this.account.signMessage({
                message: text,
            });

            await this.core.authentication.authenticate({ id, signature });
            this.authenticatedProfile = await this.core.profile.fetch({
                forProfileId: this.profileId,
            });

            this.authenticated = true;
        } catch (error) {
            elizaLogger.error("client-lens::client error: ", error);
            throw error;
        }
    }

    async createPublication(
        contentURI: string,
        onchain = false,
        commentOn?: string
    ): Promise<AnyPublicationFragment | null | undefined> {
        try {
            if (!this.authenticated) {
                await this.authenticate();
                elizaLogger.log("done authenticating");
            }
            let broadcastResult;

            if (commentOn) {
                broadcastResult = onchain
                    ? await this.createCommentOnchain(contentURI, commentOn)
                    : await this.createCommentMomoka(contentURI, commentOn);
            } else {
                broadcastResult = onchain
                    ? await this.createPostOnchain(contentURI)
                    : await this.createPostMomoka(contentURI);
            }

            elizaLogger.log("broadcastResult", broadcastResult);

            if (broadcastResult.id) {
                return await this.core.publication.fetch({
                    forId: broadcastResult.id,
                });
            }

            const completion = await this.core.transaction.waitUntilComplete({
                forTxHash: broadcastResult.txHash,
            });

            if (completion?.status === LensTransactionStatusType.Complete) {
                return await this.core.publication.fetch({
                    forTxHash: completion?.txHash,
                });
            }
        } catch (error) {
            elizaLogger.error("client-lens::client error: ", error);
            throw error;
        }
    }

    async getPublication(
        pubId: string
    ): Promise<AnyPublicationFragment | null> {
        if (this.cache.has(`lens/publication/${pubId}`)) {
            return this.cache.get(`lens/publication/${pubId}`);
        }

        const publication = await this.core.publication.fetch({ forId: pubId });

        if (publication)
            this.cache.set(`lens/publication/${pubId}`, publication);

        return publication;
    }

    async getPublicationsFor(
        profileId: string,
        limit = 50
    ): Promise<AnyPublicationFragment[]> {
        const timeline: AnyPublicationFragment[] = [];
        let next: any | undefined = undefined;

        do {
            const { items, next: newNext } = next
                ? await next()
                : await this.core.publication.fetchAll({
                      limit: LimitType.Fifty,
                      where: {
                          from: [profileId],
                          publicationTypes: [PublicationType.Post],
                      },
                  });

            items.forEach((publication) => {
                this.cache.set(
                    `lens/publication/${publication.id}`,
                    publication
                );
                timeline.push(publication);
            });

            next = newNext;
        } while (next && timeline.length < limit);

        return timeline;
    }

    async getMentions(): Promise<{
        mentions: AnyPublicationFragment[];
        next?: () => object;
    }> {
        if (!this.authenticated) {
            await this.authenticate();
        }
        // TODO: we should limit to new ones or at least latest n
        const result = await this.core.notifications.fetch({
            where: {
                highSignalFilter: false, // true,
                notificationTypes: [
                    NotificationType.Mentioned,
                    NotificationType.Commented,
                ],
            },
        });
        const mentions: AnyPublicationFragment[] = [];

        const { items, next } = result.unwrap();

        items.map((notification) => {
            let item;
            if ('publication' in notification) {
                item = notification.publication;
            } else if ('comment' in notification) {
                item = notification.comment;
            } else {
                return; // Skip notifications without the relevant properties
            }
            if (!item.isEncrypted) {
                mentions.push(item);
                this.cache.set(`lens/publication/${item.id}`, item);
            }
        });

        return { mentions, next };
    }

    async getProfile(profileId: string): Promise<Profile> {
        if (this.cache.has(`lens/profile/${profileId}`)) {
            return this.cache.get(`lens/profile/${profileId}`) as Profile;
        }

        const result = await this.core.profile.fetch({
            forProfileId: profileId,
        });
        if (!result?.id) {
            elizaLogger.error("Error fetching user by profileId");

            throw "getProfile ERROR";
        }

        const profile: Profile = {
            id: "",
            profileId,
            name: "",
            handle: "",
        };

        profile.id = result.id;
        profile.name = result.metadata?.displayName;
        profile.handle = result.handle?.localName;
        profile.bio = result.metadata?.bio;
        profile.pfp = getProfilePictureUri(result.metadata?.picture);

        this.cache.set(`lens/profile/${profileId}`, profile);

        return profile;
    }

    async getTimeline(
        profileId: string,
        limit = 10
    ): Promise<AnyPublicationFragment[]> {
        try {
            if (!this.authenticated) {
                await this.authenticate();
            }
            const timeline: AnyPublicationFragment[] = [];
            let next: any | undefined = undefined;

            do {
                const result = next
                    ? await next()
                    : await this.core.feed.fetch({
                          where: {
                              for: profileId,
                              feedEventItemTypes: [FeedEventItemType.Post],
                          },
                      });

                const data = result.unwrap();

                data.items.forEach((item) => {
                    // private posts in orb clubs are encrypted
                    if (timeline.length < limit && !item.root.isEncrypted) {
                        this.cache.set(
                            `lens/publication/${item.id}`,
                            item.root
                        );
                        timeline.push(item.root as AnyPublicationFragment);
                    }
                });

                next = data.pageInfo.next;
            } while (next && timeline.length < limit);

            return timeline;
        } catch (error) {
            elizaLogger.error(error);
            throw new Error("client-lens:: getTimeline");
        }
    }

    private async createPostOnchain(
        contentURI: string
    ): Promise<BroadcastResult | undefined> {
        // gasless + signless if they enabled the lens profile manager
        if (this.authenticatedProfile?.signless) {
            const broadcastResult = await this.core.publication.postOnchain({
                contentURI,
                openActionModules: [], // TODO: if collectable
            });
            return handleBroadcastResult(broadcastResult);
        }

        // gasless with signed type data
        const typedDataResult =
            await this.core.publication.createOnchainPostTypedData({
                contentURI,
                openActionModules: [], // TODO: if collectable
            });
        const { id, typedData } = typedDataResult.unwrap();

        const signedTypedData = await this.account.signTypedData({
            domain: omit(typedData.domain as any, "__typename"),
            types: omit(typedData.types, "__typename"),
            primaryType: "Post",
            message: omit(typedData.value, "__typename"),
        });

        const broadcastResult = await this.core.transaction.broadcastOnchain({
            id,
            signature: signedTypedData,
        });
        return handleBroadcastResult(broadcastResult);
    }

    private async createPostMomoka(
        contentURI: string
    ): Promise<BroadcastResult | undefined> {
        elizaLogger.log("createPostMomoka");
        // gasless + signless if they enabled the lens profile manager
        if (this.authenticatedProfile?.signless) {
            const broadcastResult = await this.core.publication.postOnMomoka({
                contentURI,
            });
            return handleBroadcastResult(broadcastResult);
        }

        // gasless with signed type data
        const typedDataResult =
            await this.core.publication.createMomokaPostTypedData({
                contentURI,
            });
        elizaLogger.log("typedDataResult", typedDataResult);
        const { id, typedData } = typedDataResult.unwrap();

        const signedTypedData = await this.account.signTypedData({
            domain: omit(typedData.domain as any, "__typename"),
            types: omit(typedData.types, "__typename"),
            primaryType: "Post",
            message: omit(typedData.value, "__typename"),
        });

        const broadcastResult = await this.core.transaction.broadcastOnMomoka({
            id,
            signature: signedTypedData,
        });
        return handleBroadcastResult(broadcastResult);
    }

    private async createCommentOnchain(
        contentURI: string,
        commentOn: string
    ): Promise<BroadcastResult | undefined> {
        // gasless + signless if they enabled the lens profile manager
        if (this.authenticatedProfile?.signless) {
            const broadcastResult = await this.core.publication.commentOnchain({
                commentOn,
                contentURI,
            });
            return handleBroadcastResult(broadcastResult);
        }

        // gasless with signed type data
        const typedDataResult =
            await this.core.publication.createOnchainCommentTypedData({
                commentOn,
                contentURI,
            });

        const { id, typedData } = typedDataResult.unwrap();

        const signedTypedData = await this.account.signTypedData({
            domain: omit(typedData.domain as any, "__typename"),
            types: omit(typedData.types, "__typename"),
            primaryType: "Comment",
            message: omit(typedData.value, "__typename"),
        });

        const broadcastResult = await this.core.transaction.broadcastOnchain({
            id,
            signature: signedTypedData,
        });
        return handleBroadcastResult(broadcastResult);
    }

    private async createCommentMomoka(
        contentURI: string,
        commentOn: string
    ): Promise<BroadcastResult | undefined> {
        // gasless + signless if they enabled the lens profile manager
        if (this.authenticatedProfile?.signless) {
            const broadcastResult = await this.core.publication.commentOnMomoka(
                {
                    commentOn,
                    contentURI,
                }
            );
            return handleBroadcastResult(broadcastResult);
        }

        // gasless with signed type data
        const typedDataResult =
            await this.core.publication.createMomokaCommentTypedData({
                commentOn,
                contentURI,
            });

        const { id, typedData } = typedDataResult.unwrap();

        const signedTypedData = await this.account.signTypedData({
            domain: omit(typedData.domain as any, "__typename"),
            types: omit(typedData.types, "__typename"),
            primaryType: "Comment",
            message: omit(typedData.value, "__typename"),
        });

        const broadcastResult = await this.core.transaction.broadcastOnMomoka({
            id,
            signature: signedTypedData,
        });
        return handleBroadcastResult(broadcastResult);
    }
}
