/**
 * Agent implementation of the coordinator's record/materialization effects.
 * Only the trusted, authority-locked coordinator transport may invoke it; this
 * capability does not authenticate an HTTP caller or issue a seal/boot grant.
 */

import { ElizaError } from "@elizaos/core";
import {
  type AgentBackupRestoreV3CandidateReceipt,
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3IsolatedCandidateStaging,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3StagingSession,
  parseAgentBackupRestoreV3CandidateReceipt,
} from "@elizaos/shared";
import { assembleAgentBackupRestoreV3Candidate } from "./agent-backup-restore-v3-candidate-assembly";
import { materializeAgentBackupRestoreV3CandidateCharacter } from "./agent-backup-restore-v3-candidate-character";
import { validateAgentBackupRestoreV3CandidateDatabase } from "./agent-backup-restore-v3-candidate-database-validation";
import { materializeAgentBackupRestoreV3CandidateFileSet } from "./agent-backup-restore-v3-candidate-file-set";
import {
  type AgentBackupRestoreV3CandidateFs,
  isAgentBackupRestoreV3CandidateFs,
} from "./agent-backup-restore-v3-candidate-fs";
import { snapshotOperationControl } from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";
import {
  snapshotAgentBackupRestoreV3CandidateSession,
  stageAgentBackupRestoreV3CandidateRecord,
} from "./agent-backup-restore-v3-candidate-records";

export interface AgentBackupRestoreV3CandidateMaterializer
  extends Pick<
    AgentBackupRestoreV3IsolatedCandidateStaging,
    "stageRecord" | "finishComponent"
  > {
  assembleCandidate(
    session: Readonly<AgentBackupRestoreV3StagingSession>,
    receipt: Readonly<AgentBackupRestoreV3CandidateReceipt>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<AgentBackupRestoreV3CandidateReceipt>;
}

export function createAgentBackupRestoreV3CandidateMaterializer(
  candidateFs: AgentBackupRestoreV3CandidateFs,
): AgentBackupRestoreV3CandidateMaterializer {
  if (!isAgentBackupRestoreV3CandidateFs(candidateFs))
    throw new ElizaError(
      "Agent materialization requires real quarantine filesystem authority",
      {
        code: "AGENT_BACKUP_RESTORE_V3_MATERIALIZER_INPUT_INVALID",
        severity: "fatal",
      },
    );
  const materializer: AgentBackupRestoreV3CandidateMaterializer = {
    async assembleCandidate(session, receipt, control) {
      const candidate = parseAgentBackupRestoreV3CandidateReceipt(
        JSON.parse(candidateFsCanonicalJson(receipt)),
      );
      await assembleAgentBackupRestoreV3Candidate({
        candidateFs,
        session,
        receipt: candidate,
        control,
      });
      return candidate;
    },
    async stageRecord(session, record, control) {
      const result = await stageAgentBackupRestoreV3CandidateRecord({
        candidateFs,
        session,
        record,
        control,
      });
      return result.record;
    },
    async finishComponent(session, receipt, control) {
      const component = AgentBackupRestoreV3ComponentReceiptSchema.parse(
        JSON.parse(candidateFsCanonicalJson(receipt)),
      );
      Object.freeze(component.descriptor);
      Object.freeze(component);
      const input = {
        candidateFs,
        session: snapshotAgentBackupRestoreV3CandidateSession(session),
        receipt: component,
        control: snapshotOperationControl(control),
      };
      if (component.componentName === "character")
        return (await materializeAgentBackupRestoreV3CandidateCharacter(input))
          .component;
      if (component.componentName === "database") {
        await validateAgentBackupRestoreV3CandidateDatabase(input);
        return component;
      }
      return (await materializeAgentBackupRestoreV3CandidateFileSet(input))
        .component;
    },
  };
  return Object.freeze(materializer);
}
