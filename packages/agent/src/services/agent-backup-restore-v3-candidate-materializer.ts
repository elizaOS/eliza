/**
 * Agent implementation of the coordinator's record/materialization effects.
 * Only the trusted, authority-locked coordinator transport may invoke it; this
 * capability does not authenticate an HTTP caller or issue a seal/boot grant.
 */

import { ElizaError } from "@elizaos/core";
import {
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3IsolatedCandidateStaging,
} from "@elizaos/shared";
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

export function createAgentBackupRestoreV3CandidateMaterializer(
  candidateFs: AgentBackupRestoreV3CandidateFs,
): Pick<
  AgentBackupRestoreV3IsolatedCandidateStaging,
  "stageRecord" | "finishComponent"
> {
  if (!isAgentBackupRestoreV3CandidateFs(candidateFs))
    throw new ElizaError(
      "Agent materialization requires real quarantine filesystem authority",
      {
        code: "AGENT_BACKUP_RESTORE_V3_MATERIALIZER_INPUT_INVALID",
        severity: "fatal",
      },
    );
  return Object.freeze({
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
  });
}
