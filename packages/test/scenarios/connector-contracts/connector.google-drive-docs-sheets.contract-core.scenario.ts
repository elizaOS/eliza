/** Proves confirmed Drive and Sheets writes through the production action with exact provider readback. */

import { getConnectorAccountManager, type IAgentRuntime } from "@elizaos/core";
import {
  type ScenarioContext,
  scenario,
} from "@elizaos/scenario-runner/schema";
import { LifeOpsService } from "../../../../plugins/plugin-personal-assistant/src/lifeops/service.js";

const ACCOUNT_ID = "google-drive-contract";
const GRANT_ID = `connector-account:${ACCOUNT_ID}`;
const FILE_ID = "drive-file-contract-001";
const SHEET_ID = "sheet-contract-001";

type GoogleFixture = {
  created: Array<Record<string, unknown>>;
  fileReads: string[];
  updates: Array<Record<string, unknown>>;
  sheetReads: Array<{ spreadsheetId: string; range?: string }>;
  restore: () => void;
};
const fixtures = new WeakMap<object, GoogleFixture>();

function params(action: string, extra: Record<string, unknown>) {
  return { action, grantId: GRANT_ID, ...extra };
}

async function installGoogleFixture(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  if (!ctx.runtime) return "scenario runtime is unavailable";
  const runtime = ctx.runtime as IAgentRuntime;
  const originalGoogleStatus =
    LifeOpsService.prototype.getGoogleConnectorStatus;
  LifeOpsService.prototype.getGoogleConnectorStatus = async () =>
    ({
      connected: true,
      grant: {
        id: GRANT_ID,
        connectorAccountId: ACCOUNT_ID,
        grantedScopes: ["https://www.googleapis.com/auth/drive"],
        capabilities: ["google.drive.read", "google.drive.write"],
      },
    }) as never;
  const manager = getConnectorAccountManager(runtime);
  if (!manager.getProvider("google"))
    manager.registerProvider({ provider: "google", label: "Google" });
  await manager.upsertAccount("google", {
    id: ACCOUNT_ID,
    role: "OWNER",
    purpose: ["documents"],
    accessGate: "owner_binding",
    status: "connected",
    externalId: "google-drive-contract-owner",
    displayHandle: "drive-contract@example.com",
    metadata: {
      isDefault: true,
      grantedCapabilities: ["google.drive.read", "google.drive.write"],
      grantedScopes: ["https://www.googleapis.com/auth/drive"],
    },
  });

  const service = runtime.getService("google") as Record<
    string,
    unknown
  > | null;
  if (!service) return "Google Workspace service is not registered";
  const methodNames = [
    "createDriveFile",
    "getFile",
    "updateSheetCells",
    "getSheetContent",
  ] as const;
  for (const name of methodNames) {
    if (typeof service[name] !== "function")
      return `Google Workspace service is missing ${name}`;
  }
  const originals = Object.fromEntries(
    methodNames.map((name) => [name, service[name]]),
  ) as Record<(typeof methodNames)[number], unknown>;
  const created: Array<Record<string, unknown>> = [];
  const fileReads: string[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const sheetReads: Array<{ spreadsheetId: string; range?: string }> = [];

  service.createDriveFile = async (input: Record<string, unknown>) => {
    created.push(structuredClone(input));
    return {
      id: FILE_ID,
      name: input.name,
      mimeType: input.mimeType,
      parents: [String(input.parentFolderId ?? "root")],
      webViewLink: `https://drive.google.test/file/d/${FILE_ID}`,
    };
  };
  service.getFile = async (input: { fileId: string }) => {
    fileReads.push(input.fileId);
    return {
      id: FILE_ID,
      name: "quarterly-brief.txt",
      mimeType: "text/plain",
      parents: ["board-packets"],
      webViewLink: `https://drive.google.test/file/d/${FILE_ID}`,
    };
  };
  service.updateSheetCells = async (input: Record<string, unknown>) => {
    updates.push(structuredClone(input));
    return { updatedRange: "Dashboard!B2", updatedCells: 1 };
  };
  service.getSheetContent = async (input: {
    spreadsheetId: string;
    range?: string;
  }) => {
    sheetReads.push(structuredClone(input));
    return { title: "Board Dashboard", rows: [["approved"]] };
  };
  fixtures.set(runtime as object, {
    created,
    fileReads,
    updates,
    sheetReads,
    restore: () => {
      for (const name of methodNames) service[name] = originals[name];
      LifeOpsService.prototype.getGoogleConnectorStatus = originalGoogleStatus;
    },
  });
  return undefined;
}

function verifyEffects(ctx: ScenarioContext): string | undefined {
  const fixture = fixtures.get(ctx.runtime as object);
  if (!fixture) return "Google Workspace recording fixture was not installed";
  const create = fixture.created[0];
  if (
    fixture.created.length !== 1 ||
    create?.accountId !== ACCOUNT_ID ||
    create.name !== "quarterly-brief.txt" ||
    create.mimeType !== "text/plain" ||
    create.content !== "Board packet approved for distribution." ||
    create.parentFolderId !== "board-packets"
  ) {
    return `Drive create payload mismatch: ${JSON.stringify(fixture.created)}`;
  }
  if (fixture.fileReads.join(",") !== FILE_ID)
    return `Drive readback mismatch: ${fixture.fileReads.join(",")}`;
  const update = fixture.updates[0];
  if (
    fixture.updates.length !== 1 ||
    update?.accountId !== ACCOUNT_ID ||
    update.spreadsheetId !== SHEET_ID ||
    update.range !== "Dashboard!B2" ||
    JSON.stringify(update.values) !== JSON.stringify([["approved"]])
  ) {
    return `Sheets update payload mismatch: ${JSON.stringify(fixture.updates)}`;
  }
  if (
    fixture.sheetReads.length !== 1 ||
    fixture.sheetReads[0]?.spreadsheetId !== SHEET_ID ||
    fixture.sheetReads[0]?.range !== "Dashboard!B2"
  )
    return `Sheets readback mismatch: ${JSON.stringify(fixture.sheetReads)}`;
  const results = JSON.stringify(
    ctx.actionsCalled
      .filter((call) => call.actionName === "GOOGLE_WORKSPACE")
      .map((call) => call.result),
  );
  for (const expected of [
    FILE_ID,
    "quarterly-brief.txt",
    "google-drive",
    SHEET_ID,
    "Dashboard!B2",
    "approved",
    "google-sheets",
  ]) {
    if (!results.includes(expected))
      return `action receipts/readback omitted ${expected}: ${results}`;
  }
  return undefined;
}

const createParams = params("create_file", {
  name: "quarterly-brief.txt",
  mimeType: "text/plain",
  content: "Board packet approved for distribution.",
  parentFolderId: "board-packets",
});
const updateParams = params("update_sheet", {
  spreadsheetId: SHEET_ID,
  range: "Dashboard!B2",
  values: [["approved"]],
});

export default scenario({
  id: "connector.google-drive-docs-sheets.contract-core",
  title: "Google Workspace confirmed writes and exact provider readback",
  domain: "connector-contract",
  lane: "pr-deterministic",
  executionProfile: "simulated",
  evidenceScope: "domain-contract",
  tags: [
    "connector-contract",
    "google-drive-docs-sheets",
    "connector-contract-axis:core",
    "deterministic-contract",
  ],
  description:
    "Exercises the registered production GOOGLE_WORKSPACE action over LifeOps DriveDomain with a deterministic recording Google service. It proves confirmation precedes each write, exact account-scoped provider payloads, structural receipts, and provider readback; it does not claim live Google delivery.",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  seed: [
    {
      type: "custom",
      name: "install-google-workspace-fixture",
      apply: installGoogleFixture,
    },
  ],
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "action",
      name: "propose-drive-create",
      room: "main",
      actionName: "GOOGLE_WORKSPACE",
      text: "Create the exact board packet file in Drive.",
      options: { parameters: createParams },
    },
    {
      kind: "action",
      name: "confirm-drive-create",
      room: "main",
      actionName: "GOOGLE_WORKSPACE",
      text: "Yes, create that exact file now.",
      options: { parameters: createParams },
    },
    {
      kind: "action",
      name: "read-drive-file",
      room: "main",
      actionName: "GOOGLE_WORKSPACE",
      text: "Read back the file metadata from Drive.",
      options: { parameters: params("get_file", { fileId: FILE_ID }) },
    },
    {
      kind: "action",
      name: "propose-sheet-update",
      room: "main",
      actionName: "GOOGLE_WORKSPACE",
      text: "Set the board dashboard approval cell.",
      options: { parameters: updateParams },
    },
    {
      kind: "action",
      name: "confirm-sheet-update",
      room: "main",
      actionName: "GOOGLE_WORKSPACE",
      text: "Yes, update that exact cell now.",
      options: { parameters: updateParams },
    },
    {
      kind: "action",
      name: "read-sheet-cell",
      room: "main",
      actionName: "GOOGLE_WORKSPACE",
      text: "Read back the exact updated cell from Sheets.",
      options: {
        parameters: params("get_sheet", {
          spreadsheetId: SHEET_ID,
          range: "Dashboard!B2",
        }),
      },
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "exact-drive-sheets-effects-and-readback",
      predicate: verifyEffects,
    },
  ],
  cleanup: [
    {
      type: "custom",
      name: "restore-google-workspace-service",
      apply: async (ctx) => {
        const fixture = fixtures.get(ctx.runtime as object);
        fixture?.restore();
        fixtures.delete(ctx.runtime as object);
        return undefined;
      },
    },
  ],
});
