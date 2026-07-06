/**
 * Regression test for #14715.
 *
 * The deleted LifeOps pre-LLM hook used regexes in plugin.ts to intercept
 * ordinary owner chat, including missed-call follow-up requests, document
 * signing requests, and portal-upload requests. When it matched, it skipped the
 * planner/model path and returned canned benchmark-shaped replies or queued a
 * send_message approval against an arbitrary unresolved inbox entry.
 *
 * The plugin must no longer expose that hook or canned path. Planner-selected
 * MESSAGE/OWNER_DOCUMENTS actions and structural SendPolicy/PgApprovalQueue
 * approval gates remain the supported execution path.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SAMPLE_OWNER_TEXT =
  "I missed a call from mom — help me follow up, confirm?";

describe("LifeOps missed-call regex hook removed (#14715)", () => {
  it("does not keep the pre-LLM direct-message hook or canned missed-call/portal/signature handlers", () => {
    const pluginSource = readFileSync(
      join(process.cwd(), "src/plugin.ts"),
      "utf8",
    );

    expect(SAMPLE_OWNER_TEXT).toMatch(/missed a call/i);
    expect(pluginSource).not.toContain("handleLifeOpsDirectMessageRequest");
    expect(pluginSource).not.toContain("handleLifeOpsMessageAction");
    expect(pluginSource).not.toContain("looksLikeMissedCallRepairApproval");
    expect(pluginSource).not.toContain("looksLikeDocumentSignatureRequest");
    expect(pluginSource).not.toContain("looksLikePortalUploadRequest");
    expect(pluginSource).not.toContain("buildPortalUploadIntakeResponse");
    expect(pluginSource).not.toContain("queueDocumentSignatureRequest");
    expect(pluginSource).not.toContain("registerDirectMessageHook");
    expect(pluginSource).not.toContain("unregisterDirectMessageHook");
    expect(pluginSource).not.toContain("lifeOpsMessageActionHook");
    expect(pluginSource).not.toContain("Sorry I missed your call earlier");
    expect(pluginSource).not.toContain("walkthrough");
    expect(pluginSource).not.toContain("portal_upload_intake");
    expect(pluginSource).not.toContain("pending-signature-url");
  });
});
