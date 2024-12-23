import { describe, it, expect, beforeEach, assert } from "vitest";
import { SQLite3VerifiableDAO } from "../adapters/sqliteVerifiableDAO.ts";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import os from "os";
import path from "path";
import {
    VerifiableAgent,
    VerifiableLog,
    VerifiableLogQuery,
} from "../types/logTypes.ts";
import { VerifiableLogProvider } from "../providers/verifiableLogProvider.ts";

describe("SQLite3VerifiableDAO", () => {
    let db: DatabaseType;
    let sqLite3VerifiableDAO: SQLite3VerifiableDAO;

    let verifiableLogProvider: VerifiableLogProvider;

    const teeEndpoint = "LOCAL";
    beforeEach(() => {
        const tempDir = os.tmpdir();
        const filePath = path.join(tempDir, "test2-db.sqlite");
        db = new Database(filePath);
        sqLite3VerifiableDAO = new SQLite3VerifiableDAO(db);
        verifiableLogProvider = new VerifiableLogProvider(sqLite3VerifiableDAO,"LOCAL");
    });
    describe("VerifiableLogProvider Management", () => {
        it("should verifiableLogProvider.log when available", async () => {
            let uid = uuidv4();
            await verifiableLogProvider.log(
                {
                    agentId: uid,
                    roomId: "roomId",
                    userId: "userId",
                    type: "type1",
                    content: "body1",
                },
                teeEndpoint
            );

            const pageResult1 = await sqLite3VerifiableDAO.pageQueryLogs(
                <VerifiableLogQuery>{
                    agentIdEq: uid,
                },
                1,
                2
            );
            console.log("pageResult1:", pageResult1);
            expect(pageResult1).not.toBeNull();
            assert.equal(pageResult1.data.length, 1);
        });

        it("should registerAgent and  getAgent when available", async () => {
            const testAgentId = uuidv4();
            await verifiableLogProvider.registerAgent(
                { agentId: testAgentId, agentName: "test bot" },
                teeEndpoint
            );
            console.log("testAgentId:", testAgentId);
            const agentList  = await sqLite3VerifiableDAO.listAgent();
            console.log("agentList:", agentList);

            const pageResult1 = await sqLite3VerifiableDAO.getAgent(testAgentId);
            console.log("pageResult1:", pageResult1);
            expect(pageResult1).not.toBeNull();

            const stringPromise =await verifiableLogProvider.generateAttestation({ agentId: testAgentId ,publicKey: pageResult1.agent_keypair_vlog_pk});
            console.log("stringPromise:", stringPromise);
            expect(stringPromise).not.toBeNull();
        });

    });

    describe("SQLite3VerifiableDAO Management", () => {
        it("should addLog and pageQueryLogs when available", async () => {
            let testId = uuidv4();
            await sqLite3VerifiableDAO.addLog(<VerifiableLog>{
                id: testId,
                agent_id: "dddd",
                room_id: "roomId",
                user_id: "userId",
                type: "type1",
                content: "body1",
                signature: "signed1",
            });

            const pageResult1 = await sqLite3VerifiableDAO.pageQueryLogs(
                <VerifiableLogQuery>{
                    idEq: testId,
                },
                1,
                2
            );
            console.log("pageResult1:", pageResult1);
            assert.equal(pageResult1.data.length, 1);

            const pageResult2 = await sqLite3VerifiableDAO.pageQueryLogs(
                <VerifiableLogQuery>{
                    roomIdEq: "roomId",
                    userIdEq: "userId",
                    typeEq: "type1",
                    signatureEq: "signed1",
                },
                1,
                10
            );
            expect(pageResult2).not.toBeNull();

            const pageResult3 = await sqLite3VerifiableDAO.pageQueryLogs(
                <VerifiableLogQuery>{
                    contLike: "ddd",
                },
                1,
                10
            );
            expect(pageResult3.data).not.toBeNull();

            const pageResult4 = await sqLite3VerifiableDAO.pageQueryLogs(
                <VerifiableLogQuery>{
                    contLike: "body",
                },
                1,
                10
            );
            expect(pageResult4).not.toBeNull();
        });
    });

    describe("Agent Management", () => {
        it("should add agent when available", async () => {
            const agentId = uuidv4();
            await sqLite3VerifiableDAO.addAgent(<VerifiableAgent>{
                agent_id: agentId,
                agent_name:"test bot",
                agent_keypair_path: "/secretKey/path/",
                agent_keypair_vlog_pk: "dddd的的的",
            });
            var agent = await sqLite3VerifiableDAO.getAgent(agentId);
            expect(agent).not.toBeNull();

            console.log("get agent:", agent);
        });

        it("should list agent when available", async () => {
            const agentId = uuidv4();
            await sqLite3VerifiableDAO.addAgent(<VerifiableAgent>{
                agent_id: agentId,
                agent_name:"test bot",
                agent_keypair_path: "/secretKey/path/",
                agent_keypair_vlog_pk: "dddd的的的",
            });
            const agentList = await sqLite3VerifiableDAO.listAgent();
            // determine if agentlist data is not empty
            expect(agentList).not.toBeNull();
            console.log("get agent:", agentList);
        });
    });
});
