import { describe, expect, test } from "vitest";
import type { AgentRuntime } from "@elizaos/core";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { summarizeBrowserTaskLifecycle } from "../src/lifeops/browser-session-lifecycle.js";
import { LifeOpsService } from "../src/lifeops/service.js";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";

function createRuntime(agentId: string): AgentRuntime {
  return createLifeOpsChatTestRuntime({
    agentId,
    handleTurn: async () => ({ text: "ok" }),
    useModel: async () => {
      throw new Error("useModel should not be called in browser lifecycle tests");
    },
  });
}

async function createService(agentId: string): Promise<LifeOpsService> {
  const runtime = createRuntime(agentId);
  await LifeOpsRepository.bootstrapSchema(runtime);
  const service = new LifeOpsService(runtime);
  await service.updateBrowserSettings({
    enabled: true,
    allowBrowserControl: true,
  });
  await service.syncBrowserState({
    companion: {
      browser: "chrome",
      profileId: "profile-1",
      label: "LifeOps Browser Chrome",
      connectionState: "connected",
      permissions: {
        tabs: true,
        scripting: true,
        activeTab: true,
        allOrigins: true,
        grantedOrigins: ["https://speaker-portal.example.com"],
        incognitoEnabled: false,
      },
    },
    tabs: [
      {
        browser: "chrome",
        profileId: "profile-1",
        windowId: "window-1",
        tabId: "tab-1",
        url: "https://speaker-portal.example.com",
        title: "Speaker Portal",
        activeInWindow: true,
        focusedWindow: true,
        focusedActive: true,
      },
    ],
    pageContexts: [
      {
        browser: "chrome",
        profileId: "profile-1",
        windowId: "window-1",
        tabId: "tab-1",
        url: "https://speaker-portal.example.com",
        title: "Speaker Portal",
        mainText: "Speaker submissions",
      },
    ],
  });
  return service;
}

describe("browser session lifecycle", () => {
  test("tracks blocked intervention, resume, uploaded asset, and provenance", async () => {
    const service = await createService("lifeops-browser-session-lifecycle");
    const session = await service.createBrowserSession({
      title: "Upload keynote deck",
      browser: "chrome",
      profileId: "profile-1",
      companionId: (await service.listBrowserCompanions())[0]?.id ?? null,
      actions: [
        {
          kind: "open",
          label: "Open speaker portal",
          url: "https://speaker-portal.example.com/submissions",
          selector: null,
          text: null,
          accountAffecting: false,
          requiresConfirmation: false,
          metadata: { workflowKind: "portal_upload" },
        },
        {
          kind: "click",
          label: "Submit deck",
          url: null,
          selector: "#submit-upload",
          text: null,
          accountAffecting: true,
          requiresConfirmation: true,
          metadata: { workflowKind: "portal_upload" },
        },
      ],
    });

    expect(session.status).toBe("awaiting_confirmation");

    const confirmed = await service.confirmBrowserSession(session.id, {
      confirmed: true,
    });
    expect(summarizeBrowserTaskLifecycle(confirmed)).toMatchObject({
      approvalRequired: true,
      approvalSatisfied: true,
      completed: false,
    });

    const blocked = await service.updateBrowserSessionProgress(session.id, {
      currentActionIndex: 1,
      result: {
        browserTask: {
          needsHuman: true,
          blockedReason: "portal login required",
          artifacts: [
            {
              kind: "input_asset",
              label: "milady-keynote.pdf",
              detail: "received from chat",
            },
          ],
          interventions: [
            {
              kind: "login",
              reason: "Portal sign-in required",
              status: "requested",
              channel: "dashboard",
            },
          ],
        },
      },
    });
    expect(summarizeBrowserTaskLifecycle(blocked)).toMatchObject({
      needsHuman: true,
      blockedReason: "Portal sign-in required",
      artifactCount: 1,
      interventionCount: 1,
    });

    const resumed = await service.updateBrowserSessionProgress(session.id, {
      result: {
        browserTask: {
          needsHuman: false,
          interventions: [
            {
              kind: "login",
              reason: "Portal sign-in required",
              status: "resolved",
              channel: "dashboard",
            },
          ],
          provenance: [
            {
              provider: "speaker_portal",
              label: "Speaker Portal Submission",
              url: "https://speaker-portal.example.com/submissions/rec-123",
              externalId: "rec-123",
            },
          ],
          uploadedAssets: [
            {
              kind: "uploaded_deck",
              label: "milady-keynote.pdf",
              detail: "uploaded to speaker portal",
              uploaded: true,
            },
          ],
        },
      },
    });
    expect(summarizeBrowserTaskLifecycle(resumed)).toMatchObject({
      needsHuman: false,
      uploadedAssetCount: 1,
      provenanceCount: 1,
    });

    const completed = await service.completeBrowserSession(session.id, {
      status: "done",
    });
    expect(summarizeBrowserTaskLifecycle(completed)).toMatchObject({
      completed: true,
      approvalSatisfied: true,
      uploadedAssetCount: 1,
      provenanceCount: 1,
      interventionCount: 1,
    });
  });

  test("owner progress route preserves browser task summary before completion", async () => {
    const service = await createService("lifeops-browser-session-progress-owner");
    const session = await service.createBrowserSession({
      title: "Upload ID copy",
      browser: "chrome",
      profileId: "profile-1",
      companionId: (await service.listBrowserCompanions())[0]?.id ?? null,
      actions: [
        {
          kind: "open",
          label: "Open verification portal",
          url: "https://speaker-portal.example.com/identity",
          selector: null,
          text: null,
          accountAffecting: false,
          requiresConfirmation: false,
          metadata: { workflowKind: "identity_upload" },
        },
      ],
    });

    const progressed = await service.updateBrowserSessionProgress(session.id, {
      result: {
        browserTask: {
          artifacts: [
            {
              kind: "id_copy",
              label: "passport-front.jpg",
              detail: "artifact attached for verification",
            },
          ],
        },
      },
    });

    expect(summarizeBrowserTaskLifecycle(progressed)).toMatchObject({
      completed: false,
      needsHuman: false,
      artifactCount: 1,
    });
  });
});
