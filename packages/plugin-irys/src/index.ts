import { Plugin } from "@elizaos/core";
import IrysService from "./services/irysService";

const irysPlugin: Plugin = {
    name: "plugin-irys",
    description: "Store and retrieve data on Irys to create a decentralized knowledge base and enable multi-agent collaboration",
    actions: [],
    providers: [],
    evaluators: [],
    clients: [],
    services: [new IrysService()],
}

export default irysPlugin;
