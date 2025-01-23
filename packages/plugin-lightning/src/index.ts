export * from "./actions/createInvoice";
export * from "./providers/lightning";
export * from "./types";

import type { Plugin } from "@elizaos/core";
import { createInvoiceAction } from "./actions/createInvoice";
import { payInvoiceAction } from "./actions/payInvoice";

export const lightningPlugin: Plugin = {
    name: "lightning",
    description: "lightning integration plugin",
    actions: [createInvoiceAction, payInvoiceAction],
};

export default lightningPlugin;
