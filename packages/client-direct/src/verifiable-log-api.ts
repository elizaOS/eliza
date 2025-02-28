import express from "express";
import type { Router } from 'express';
import bodyParser from "body-parser";
import cors from "cors";

import { type AgentRuntime, elizaLogger, ServiceType }  from "@elizaos/core";
import type {
    VerifiableLogService,
    VerifiableLogQuery,
} from "@elizaos/plugin-tee-verifiable-log";

export function createVerifiableLogApiRouter(
    agents: Map<string, IAgentRuntime>
):Router {
    const router = express.Router();
    router.use(cors());
    router.use(bodyParser.json());
    router.use(bodyParser.urlencoded({ extended: true }));

    router.get(
        "/verifiable/agents",
        async (req: express.Request, res: express.Response) => {
            try {
                // call the listAgent method
                const agentRuntime: AgentRuntime | undefined = agents.values().next().value;
                const pageQuery = await agentRuntime
                    .getService<VerifiableLogService>(
                        ServiceType.VERIFIABLE_LOGGING
                    )
                    .listAgent();

                res.json({
                    success: true,
                    message: "Successfully get Agents",
                    data: pageQuery,
                });
            } catch (error) {
                elizaLogger.error("Detailed error:", error);
                res.status(500).json({
                    error: "failed to get agents registered ",
                    details: error.message,
                    stack: error.stack,
                });
            }
        }
    );
    router.post(
        "/verifiable/attestation",
        async (req: express.Request, res: express.Response) => {
            try {
                const query = req.body || {};

                const verifiableLogQuery = {
                    agentId: query.agentId || "",
                    publicKey: query.publicKey || "",
                };
                const agentRuntime: AgentRuntime | undefined = agents.values().next().value;
                const pageQuery = await agentRuntime
                    .getService<VerifiableLogService>(
                        ServiceType.VERIFIABLE_LOGGING
                    )
                    .generateAttestation(verifiableLogQuery);

                res.json({
                    success: true,
                    message: "Successfully get Attestation",
                    data: pageQuery,
                });
            } catch (error) {
                elizaLogger.error("Detailed error:", error);
                res.status(500).json({
                    error: "Failed to Get Attestation",
                    details: error.message,
                    stack: error.stack,
                });
            }
        }
    );
    router.post(
        "/verifiable/logs",
        async (req: express.Request, res: express.Response) => {
            try {
                const query = req.body.query || {};
                const page = Number.parseInt(req.body.page) || 1;
                const pageSize = Number.parseInt(req.body.pageSize) || 10;

                const verifiableLogQuery: VerifiableLogQuery = {
                    idEq: query.idEq || "",
                    agentIdEq: query.agentIdEq || "",
                    roomIdEq: query.roomIdEq || "",
                    userIdEq: query.userIdEq || "",
                    typeEq: query.typeEq || "",
                    contLike: query.contLike || "",
                    signatureEq: query.signatureEq || "",
                };
                const agentRuntime: AgentRuntime | undefined = agents.values().next().value;
                const pageQuery = await agentRuntime
                    .getService<VerifiableLogService>(
                        ServiceType.VERIFIABLE_LOGGING
                    )
                    ?.pageQueryLogs(verifiableLogQuery, page, pageSize);

                res.json({
                    success: true,
                    message: "Successfully retrieved logs",
                    data: pageQuery,
                });
            } catch (error) {
                elizaLogger.error("Detailed error:", error);
                res.status(500).json({
                    error: "Failed to Get Verifiable Logs",
                    details: error.message,
                    stack: error.stack,
                });
            }
        }
    );

    return router;
}
