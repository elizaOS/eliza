/* eslint-disable prefer-const */
import { RouterContext } from "koa-router";
import { Next } from "koa";
import type { File } from "formidable";

import { Server } from "@server";
import { FileSystem } from "@server/fileSystem";
import { isEmpty, isNotEmpty } from "@server/helpers/utils";
import { Message } from "@server/databases/imessage/entity/Message";
import { MessageInterface } from "@server/api/interfaces/messageInterface";
import { MessagePromiseRejection } from "@server/managers/outgoingMessageManager/messagePromise";
import { MessageSerializer } from "@server/api/serializers/MessageSerializer";
import { arrayHasOne } from "@server/utils/CollectionUtils";
import { FileStream, Success } from "../responses/success";
import { BadRequest, IMessageError, NotFound } from "../responses/errors";
import { parseWithQuery } from "../utils";
import { isMinVentura } from "@server/env";

export class MessageRouter {
    static async sentCount(ctx: RouterContext, _: Next) {
        const { after, before, chatGuid, minRowId, maxRowId } = ctx.request.query;
        const beforeDate = isNotEmpty(before) ? new Date(Number.parseInt(before as string, 10)) : null;
        const afterDate = isNotEmpty(after) ? new Date(Number.parseInt(after as string, 10)) : null;
        const minRowIdValue = isNotEmpty(minRowId) ? Number.parseInt(minRowId as string, 10) : null;
        const maxRowIdValue = isNotEmpty(maxRowId) ? Number.parseInt(maxRowId as string, 10) : null;
        const total = await Server().iMessageRepo.getMessageCount({
            after: afterDate,
            before: beforeDate,
            chatGuid: chatGuid as string,
            minRowId: minRowIdValue,
            maxRowId: maxRowIdValue,
            isFromMe: true
        });

        return new Success(ctx, { data: { total } }).send();
    }

    static async count(ctx: RouterContext, _: Next) {
        const { after, before, chatGuid, minRowId, maxRowId } = ctx.request.query;
        const beforeDate = isNotEmpty(before) ? new Date(Number.parseInt(before as string, 10)) : null;
        const afterDate = isNotEmpty(after) ? new Date(Number.parseInt(after as string, 10)) : null;
        const minRowIdValue = isNotEmpty(minRowId) ? Number.parseInt(minRowId as string, 10) : null;
        const maxRowIdValue = isNotEmpty(maxRowId) ? Number.parseInt(maxRowId as string, 10) : null;
        const total = await Server().iMessageRepo.getMessageCount({
            after: afterDate,
            before: beforeDate,
            chatGuid: chatGuid as string,
            minRowId: minRowIdValue,
            maxRowId: maxRowIdValue
        });

        return new Success(ctx, { data: { total } }).send();
    }

    static async countUpdated(ctx: RouterContext, _: Next) {
        const { after, before, chatGuid, minRowId, maxRowId } = ctx.request.query;
        const beforeDate = isNotEmpty(before) ? new Date(Number.parseInt(before as string, 10)) : null;
        const afterDate = isNotEmpty(after) ? new Date(Number.parseInt(after as string, 10)) : null;
        const minRowIdValue = isNotEmpty(minRowId) ? Number.parseInt(minRowId as string, 10) : null;
        const maxRowIdValue = isNotEmpty(maxRowId) ? Number.parseInt(maxRowId as string, 10) : null;
        const total = await Server().iMessageRepo.getMessageCount({
            after: afterDate,
            before: beforeDate,
            chatGuid: chatGuid as string,
            updated: true,
            minRowId: minRowIdValue,
            maxRowId: maxRowIdValue
        });

        return new Success(ctx, { data: { total } }).send();
    }

    static async find(ctx: RouterContext, _: Next) {
        const { guid } = ctx.params;
        const withQuery = parseWithQuery(ctx.request.query.with);
        const withChats = arrayHasOne(withQuery, ["chats", "chat"]);
        const withParticipants = arrayHasOne(withQuery, ["chats.participants", "chat.participants"]);
        const withAttachments = arrayHasOne(withQuery, ["attachment", "attachments"]);
        const withAttributedBody = arrayHasOne(withQuery, ["attributedBody", "attributed-body"]);
        const withMessageSummaryInfo = arrayHasOne(withQuery, ["messageSummaryInfo", "message-summary-info"]);
        const withPayloadData = arrayHasOne(withQuery, ["payloadData", "payload-data"]);

        // Fetch the info for the message by GUID
        const message = await Server().iMessageRepo.getMessage(guid, withChats, withAttachments);
        if (!message) throw new NotFound({ error: "Message does not exist!" });

        // If we want participants of the chat, fetch them
        if (withParticipants) {
            for (const i of message.chats ?? []) {
                const [chats, __] = await Server().iMessageRepo.getChats({
                    chatGuid: i.guid,
                    withParticipants,
                    withLastMessage: false,
                    withArchived: true
                });

                if (isEmpty(chats)) continue;
                i.participants = chats[0].participants;
            }
        }

        return new Success(ctx, {
            data: await MessageSerializer.serialize({
                message,
                config: {
                    parseAttributedBody: withAttributedBody,
                    parseMessageSummary: withMessageSummaryInfo,
                    parsePayloadData: withPayloadData
                }
            })
        }).send();
    }

    static async query(ctx: RouterContext, _: Next) {
        let {
            chatGuid,
            with: withQuery,
            offset,
            limit,
            where,
            sort,
            after,
            before,
            convertAttachments
        } = ctx?.request?.body ?? {};

        // Pull out the filters
        withQuery = parseWithQuery(withQuery);
        const withChats = arrayHasOne(withQuery, ["chat", "chats"]);
        const withAttachments = arrayHasOne(withQuery, ["attachment", "attachments"]);
        const withAttachmentMetadata = arrayHasOne(withQuery, ["attachment.metadata", "attachments.metadata"]);
        const withChatParticipants = arrayHasOne(withQuery, ["chat.participants", "chats.participants"]);
        const withAttributedBody = arrayHasOne(withQuery, ["attributedbody", "attributed-body"]);
        const withMessageSummaryInfo = arrayHasOne(withQuery, ["messageSummaryInfo", "message-summary-info"]);
        const withPayloadData = arrayHasOne(withQuery, ["payloadData", "payload-data"]);

        // We don't need to worry about it not being a number because
        // the validator checks for that. It also checks for min values.
        offset = offset ? Number.parseInt(offset, 10) : 0;
        limit = limit ? Number.parseInt(limit, 10) : 100;

        if (chatGuid) {
            const [chats, __] = await Server().iMessageRepo.getChats({ chatGuid });
            if (isEmpty(chats))
                return new Success(ctx, {
                    message: `No chat found with GUID: ${chatGuid}`,
                    data: []
                });
        }

        let messages, totalCount;

        // If the Private API is enabled and we are on ventura or newer, we have to use the Private API to search.
        // This is because the DB's message.text column is NULL for all outgoing messages.
        // We have to use the Spotlight API via the Private API helper to execute the search.
        // The Private API will return the GUIDs of the messages that match the search term.
        // We will remove the .text query and insert a GUID query.
        const privateApiEnabled = Server().repo.getConfig("enable_private_api") as boolean;
        if (isMinVentura && privateApiEnabled && isNotEmpty(where)) {
            // Sample statement: message.text LIKE :term COLLATE NOCASE
            // Find any where statement that has message.text <operator> <variable>
            const textQueries = where.filter((w: any) => w.statement.includes("message.text"));
            if (textQueries.length === 1) {
                // Find the variable name
                const variable = textQueries[0].statement.split(" ")[2].replace(":", "");
                const operator = textQueries[0].statement.split(" ")[1];
                const term = textQueries[0].args[variable];
                
                // Strip the % wildcards from the start/end
                const strippedTerm = term.replace(/^%+|%+$/g, "");

                // Remove the text query from the where clause
                where = where.filter((w: any) => !w.statement.includes("message.text"));

                // Set the match type based on the operator
                // let matchType: 'contains' | 'exact' = 'contains';
                // if (['=', 'is'].includes(operator.toLowerCase())) {
                //     matchType = 'exact';
                // }

                // To match the behavior of the DB search, we will use the 'exact' match type.
                // Exact match for the Spotlight API actually means "contains".
                // A contains match in the Spotlight API tokenizes the search term and matches any token.
                const matchType = 'contains';

                [messages, totalCount] = await MessageInterface.searchMessagesPrivateApi({
                    chatGuid,
                    withChats: withChats || withChatParticipants,
                    withAttachments,
                    offset,
                    limit,
                    sort,
                    before,
                    after,
                    where: where ?? [],
                    query: strippedTerm,
                    matchType
                });
            }
        }

        // If these are null, it means that the Private API is disabled or we are on a version older than Ventura.
        // Or the where clause had multiple text queries, which is not supported currently in the Private API search.
        if (messages == null && totalCount == null) {
            [messages, totalCount] = await Server().iMessageRepo.getMessages({
                chatGuid,
                withChats: withChats || withChatParticipants,
                withAttachments,
                offset,
                limit,
                sort,
                before,
                after,
                where: where ?? []
            });
        }

        const data = await MessageSerializer.serializeList({
            messages,
            attachmentConfig: {
                loadMetadata: withAttachmentMetadata,
                convert: convertAttachments
            },
            config: {
                parseAttributedBody: withAttributedBody,
                parseMessageSummary: withMessageSummaryInfo,
                parsePayloadData: withPayloadData,
                loadChatParticipants: withChatParticipants
            }
        });

        // Build metadata to return
        const metadata = { offset, limit, total: totalCount, count: data.length };
        return new Success(ctx, { data, message: "Successfully fetched messages!", metadata }).send();
    }

    static async sendText(ctx: RouterContext, _: Next) {
        let {
            tempGuid, message, attributedBody, method, chatGuid,
            effectId, subject, selectedMessageGuid, partIndex, ddScan
        } = ctx?.request?.body ?? {};

        // Add to send cache
        Server().httpService.sendCache.add(tempGuid);

        try {
            // Send the message
            const sentMessage = await MessageInterface.sendMessageSync({
                chatGuid,
                message,
                method,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                tempGuid,
                partIndex,
                ddScan
            });

            // Remove from cache
            Server().httpService.sendCache.remove(tempGuid);

            // Convert to an API response
            // No need to load the participants since we sent the message
            const data = await MessageSerializer.serialize({
                message: sentMessage,
                config: {
                    loadChatParticipants: false,
                    parseAttributedBody: true,
                    parseMessageSummary: true,
                    parsePayloadData: true
                }
            });

            // Inject the TempGUID back into the response
            if (isNotEmpty(tempGuid)) {
                data.tempGuid = tempGuid;
            }

            if ((data.error ?? 0) !== 0) {
                throw new IMessageError({
                    message: "Message sent with an error. See attached message",
                    error: "Message failed to send!",
                    data
                });
            } else {
                return new Success(ctx, { message: "Message sent!", data }).send();
            }
        } catch (ex: any) {
            // Remove from cache
            Server().httpService.sendCache.remove(tempGuid);

            if (ex instanceof Message) {
                throw new IMessageError({
                    message: "Message Send Error",
                    // No need to load the participants since we sent the message
                    data: await MessageSerializer.serialize({
                        message: ex,
                        config: {
                            loadChatParticipants: false
                        }
                    }),
                    error: "Failed to send message! See attached message error code."
                });
            } else if (ex instanceof MessagePromiseRejection) {
                throw new IMessageError({
                    message: "Message Send Error",
                    // No need to load the participants since we sent the message
                    data: ex?.msg
                        ? await MessageSerializer.serialize({
                              message: ex.msg,
                              config: {
                                  loadChatParticipants: false
                              }
                          })
                        : null,
                    error: "Failed to send message! See attached message error code."
                });
            } else {
                throw new IMessageError({ message: "Message Send Error", error: ex?.message ?? ex.toString() });
            }
        }
    }

    static async sendAttachment(ctx: RouterContext, _: Next) {
        const { files } = ctx.request;
        const { tempGuid, chatGuid, name, method, subject, selectedMessageGuid, partIndex, effectId, isAudioMessage } =
            ctx.request?.body ?? {};
        const attachment = files?.attachment as File;

        // Add to send cache
        Server().httpService.sendCache.add(tempGuid);

        // Send the attachment
        try {
            const sentMessage: Message = await MessageInterface.sendAttachmentSync({
                chatGuid,
                attachmentPath: attachment.path,
                attachmentName: name,
                attachmentGuid: tempGuid,
                method,
                isAudioMessage,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex
            });

            // Remove from cache
            Server().httpService.sendCache.remove(tempGuid);

            // Convert to an API response
            // No need to load the participants since we sent the message
            const data = await MessageSerializer.serialize({
                message: sentMessage,
                config: {
                    loadChatParticipants: false,
                    parseAttributedBody: true,
                    parseMessageSummary: true,
                    parsePayloadData: true
                }
            });
            return new Success(ctx, { message: "Attachment sent!", data }).send();
        } catch (ex: any) {
            // Remove from cache
            Server().httpService.sendCache.remove(tempGuid);

            if (ex instanceof Message) {
                throw new IMessageError({
                    message: "Attachment Send Error",
                    // No need to load the participants since we sent the message
                    data: await MessageSerializer.serialize({
                        message: ex,
                        config: {
                            loadChatParticipants: false
                        }
                    }),
                    error: "Failed to send attachment! See attached message error code."
                });
            } else if (ex instanceof MessagePromiseRejection) {
                throw new IMessageError({
                    message: "Attachment Send Error",
                    // No need to load the participants since we sent the message
                    data: ex?.msg
                        ? await MessageSerializer.serialize({
                              message: ex.msg,
                              config: {
                                  loadChatParticipants: false
                              }
                          })
                        : null,
                    error: "Failed to send attachment! See attached message error code."
                });
            } else {
                throw new IMessageError({ message: "Attachment Send Error", error: ex?.message ?? ex.toString() });
            }
        }
    }

    static async sendMultipartMessage(ctx: RouterContext, _: Next) {
        let { parts, tempGuid, attributedBody, chatGuid, effectId, subject, selectedMessageGuid, partIndex, ddScan } =
            ctx?.request?.body ?? {};

        // Remove from cache
        if (isNotEmpty(tempGuid)) {
            Server().httpService.sendCache.add(tempGuid);
        }

        try {
            // Send the message
            const sentMessage = await MessageInterface.sendMultipart({
                chatGuid,
                parts,
                attributedBody,
                subject,
                effectId,
                selectedMessageGuid,
                partIndex,
                ddScan
            });

            // Remove from cache
            Server().httpService.sendCache.remove(tempGuid);

            // Convert to an API response
            // No need to load the participants since we sent the message
            const data = await MessageSerializer.serialize({
                message: sentMessage,
                config: {
                    loadChatParticipants: false,
                    parseAttributedBody: true,
                    parseMessageSummary: true,
                    parsePayloadData: true
                }
            });

            // Inject the TempGUID back into the response
            if (isNotEmpty(tempGuid)) {
                data.tempGuid = tempGuid;
            }

            if ((data.error ?? 0) !== 0) {
                throw new IMessageError({
                    message: "Message sent with an error. See attached message",
                    error: "Message failed to send!",
                    data
                });
            } else {
                return new Success(ctx, { message: "Message sent!", data }).send();
            }
        } catch (ex: any) {
            // Remove from cache
            Server().httpService.sendCache.remove(tempGuid);

            if (ex instanceof Message) {
                throw new IMessageError({
                    message: "Message Send Error",
                    // No need to load the participants since we sent the message
                    data: await MessageSerializer.serialize({
                        message: ex,
                        config: {
                            loadChatParticipants: false
                        }
                    }),
                    error: "Failed to send message! See attached message error code."
                });
            } else if (ex instanceof MessagePromiseRejection) {
                throw new IMessageError({
                    message: "Message Send Error",
                    // No need to load the participants since we sent the message
                    data: ex?.msg
                        ? await MessageSerializer.serialize({
                              message: ex.msg,
                              config: {
                                  loadChatParticipants: false
                              }
                          })
                        : null,
                    error: "Failed to send message! See attached message error code."
                });
            } else {
                throw new IMessageError({ message: "Message Send Error", error: ex?.message ?? ex.toString() });
            }
        }
    }

    static async react(ctx: RouterContext, _: Next) {
        const { chatGuid, selectedMessageGuid, reaction, partIndex } = ctx?.request?.body ?? {};

        // Fetch the message we are reacting to
        const message = await Server().iMessageRepo.getMessage(selectedMessageGuid, false, true);
        if (!message) throw new BadRequest({ error: "Selected message does not exist!" });

        // Send the reaction
        try {
            const sentMessage = await MessageInterface.sendReaction({ chatGuid, message, reaction, partIndex });
            return new Success(ctx, {
                message: "Reaction sent!",
                // No need to load the participants since we sent the message
                data: await MessageSerializer.serialize({
                    message: sentMessage,
                    config: {
                        loadChatParticipants: false,
                        parseAttributedBody: true,
                        parseMessageSummary: true,
                        parsePayloadData: true
                    }
                })
            }).send();
        } catch (ex: any) {
            if (ex instanceof Message) {
                throw new IMessageError({
                    message: "Reaction Send Error",
                    // No need to load the participants since we sent the message
                    data: await MessageSerializer.serialize({
                        message: ex,
                        config: {
                            loadChatParticipants: false
                        }
                    }),
                    error: "Failed to send reaction! See attached message error code."
                });
            } else if (ex instanceof MessagePromiseRejection) {
                throw new IMessageError({
                    message: "Reaction Send Error",
                    // No need to load the participants since we sent the message
                    data: ex?.msg
                        ? await MessageSerializer.serialize({
                              message: ex.msg,
                              config: {
                                  loadChatParticipants: false
                              }
                          })
                        : null,
                    error: "Failed to send reaction! See attached message error code."
                });
            } else {
                throw new IMessageError({ message: "Reaction Send Error", error: ex?.message ?? ex.toString() });
            }
        }
    }

    static async unsendMessage(ctx: RouterContext, _: Next) {
        const { guid: messageGuid } = ctx.params ?? {};
        const { partIndex } = ctx?.request?.body ?? {};

        // Fetch the message we are reacting to
        const message = await Server().iMessageRepo.getMessage(messageGuid, true, true);
        if (!message) throw new BadRequest({ error: "Selected message does not exist!" });

        if (isEmpty(message?.chats ?? [])) throw new BadRequest({ error: "Associated chat not found!" });
        const chatGuid = message.chats[0].guid;

        // Unsend the message
        try {
            const unsentMessage = await MessageInterface.unsendMessage({ chatGuid, messageGuid, partIndex });
            return new Success(ctx, {
                message: "Message unsent!",
                // No need to load the participants since we sent the message
                data: await MessageSerializer.serialize({
                    message: unsentMessage,
                    config: {
                        loadChatParticipants: false,
                        parseAttributedBody: true,
                        parseMessageSummary: true,
                        parsePayloadData: true
                    }
                })
            }).send();
        } catch (ex: any) {
            if (ex instanceof Message) {
                throw new IMessageError({
                    message: "Unsend Message Error",
                    // No need to load the participants since we sent the message
                    data: await MessageSerializer.serialize({
                        message: ex,
                        config: {
                            loadChatParticipants: false
                        }
                    }),
                    error: "Failed to unsend message! See attached message error code."
                });
            } else if (ex instanceof MessagePromiseRejection) {
                throw new IMessageError({
                    message: "Unsend Message Error",
                    // No need to load the participants since we sent the message
                    data: ex?.msg
                        ? await MessageSerializer.serialize({
                              message: ex.msg,
                              config: {
                                  loadChatParticipants: false
                              }
                          })
                        : null,
                    error: "Failed to unsend message! See attached message error code."
                });
            } else {
                throw new IMessageError({ message: "Unsend Message Error", error: ex?.message ?? ex.toString() });
            }
        }
    }

    static async editMessage(ctx: RouterContext, _: Next) {
        const { guid: messageGuid } = ctx.params ?? {};
        const { editedMessage, backwardsCompatibilityMessage, partIndex } = ctx?.request?.body ?? {};

        // Fetch the message we are reacting to
        const message = await Server().iMessageRepo.getMessage(messageGuid, true, true);
        if (!message) throw new BadRequest({ error: "Selected message does not exist!" });

        if (isEmpty(message?.chats ?? [])) throw new BadRequest({ error: "Associated chat not found!" });
        const chatGuid = message.chats[0].guid;

        // Edit the message
        try {
            const changedMessage = await MessageInterface.editMessage({
                chatGuid,
                messageGuid,
                editedMessage,
                backwardsCompatMessage: backwardsCompatibilityMessage,
                partIndex
            });

            return new Success(ctx, {
                message: "Message edited!",
                // No need to load the participants since we sent the message
                data: await MessageSerializer.serialize({
                    message: changedMessage,
                    config: {
                        loadChatParticipants: false,
                        parseAttributedBody: true,
                        parseMessageSummary: true,
                        parsePayloadData: true
                    }
                })
            }).send();
        } catch (ex: any) {
            if (ex instanceof Message) {
                throw new IMessageError({
                    message: "Message Edit Error",
                    // No need to load the participants since we sent the message
                    data: await MessageSerializer.serialize({
                        message: ex,
                        config: {
                            loadChatParticipants: false
                        }
                    }),
                    error: "Failed to edit message! See attached message error code."
                });
            } else if (ex instanceof MessagePromiseRejection) {
                throw new IMessageError({
                    message: "Message Edit Error",
                    // No need to load the participants since we sent the message
                    data: ex?.msg
                        ? await MessageSerializer.serialize({
                              message: ex.msg,
                              config: {
                                  loadChatParticipants: false
                              }
                          })
                        : null,
                    error: "Failed to edit message! See attached message error code."
                });
            } else {
                throw new IMessageError({ message: "Message Edit Error", error: ex?.message ?? ex.toString() });
            }
        }
    }

    static async getEmbeddedMedia(ctx: RouterContext, _: Next) {
        const { guid: messageGuid } = ctx?.params ?? {};

        // Fetch the message we are reacting to
        const message = await Server().iMessageRepo.getMessage(messageGuid, true, false);
        if (!message) throw new BadRequest({ error: "Selected message does not exist!" });

        // Pull the associated chat
        if (isEmpty(message?.chats ?? [])) throw new BadRequest({ error: "Associated chat not found!" });
        const chat = message.chats[0];

        const mediaPath = await MessageInterface.getEmbeddedMedia(chat, message);
        if (!mediaPath) throw new NotFound({ error: "No embedded media found!" });

        const fullPath = FileSystem.getRealPath(mediaPath);
        let mimeType = "image/png";
        if (message.isDigitalTouch) {
            mimeType = "video/quicktime";
        }

        return new FileStream(ctx, fullPath, mimeType).send();
    }

    static async notify(ctx: RouterContext, _: Next) {
        const { guid: messageGuid } = ctx?.params ?? {};

        // Fetch the message we are reacting to
        const message = await Server().iMessageRepo.getMessage(messageGuid, true, false);
        if (!message) throw new BadRequest({ error: "Selected message does not exist!" });

        // Pull the associated chat
        if (isEmpty(message?.chats ?? [])) throw new BadRequest({ error: "Associated chat not found!" });
        const chat = message.chats[0];

        // Attempt to notify the user
        const retMessage = await MessageInterface.notifySilencedMessage(chat, message);
        return new Success(ctx, {
            data: await MessageSerializer.serialize({
                message: retMessage,
                config: {
                    parseAttributedBody: true,
                    parseMessageSummary: true,
                    parsePayloadData: true
                }
            })
        }).send();
    }
}
