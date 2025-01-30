import {type IAgentRuntime, elizaLogger} from "@elizaos/core";

export function isUserAuthorized(
    userId: string,
    runtime: IAgentRuntime
): boolean {
    const authorizedUserId = runtime.getSetting("ACCESS_TOKEN_MANAGEMENT_TO");
    elizaLogger.log("UserID from message:", userId);
    elizaLogger.log("Authorized UserID:", authorizedUserId);
    if (authorizedUserId === "everyone") {
        return true;
    }
    return userId === authorizedUserId;
}
