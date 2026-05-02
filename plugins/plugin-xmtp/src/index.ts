import { Plugin } from "@elizaos/core";
import { XMTP_SERVICE_NAME } from "./constants";
import { XmtpService } from "./service";

const xmtpPlugin: Plugin = {
    name: XMTP_SERVICE_NAME,
    description: "XMTP service plugin for ElizaOS.",
    services: [XmtpService],
};
export default xmtpPlugin;
