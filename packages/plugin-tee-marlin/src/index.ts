import { Plugin } from "@elizaos/core";
import { remoteAttestationAction } from "./actions/remoteAttestation";

export const teeMarlinPlugin: Plugin = {
    name: "Marlin TEE Plugin",
    description:
        "TEE plugin with actions to generate remote attestations",
    actions: [
        /* custom actions */
        remoteAttestationAction,
    ],
    evaluators: [
        /* custom evaluators */
    ],
    providers: [
        /* custom providers */
    ],
    services: [
        /* custom services */
    ],
};
