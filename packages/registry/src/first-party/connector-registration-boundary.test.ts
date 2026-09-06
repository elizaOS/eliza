/**
 * Executable registration-boundary ratchet (#24373): executes each bundled
 * channel plugin's real registration seam (the static registerSendHandlers /
 * exported factory the runtime calls at boot) against an observing runtime and
 * requires every channel claim in the committed connector truth inventory to be
 * backed by a registration the PLUGIN ITSELF produced in that execution.
 *
 * This closes the gap ss251 demonstrated by mutation: the source-inspection
 * rows stay green when the production `runtime.registerMessageConnector` call
 * is disabled (`if (false) runtime.registerMessageConnector(registration)`),
 * because nothing in that suite executes the plugin. Here the seam IS the
 * production registration path — disabling the call removes the observed
 * source and this suite fails. Complements the literal-shape inventory in
 * connector-truth-inventory.test.ts, which pins generator parity.
 *
 * Deterministic and credential-free: no network, no database; the fake services
 * follow the Object.create(<Service>.prototype) pattern the plugins' own suites
 * use (see plugin-instagram accounts.test.ts), and the fake runtime is an
 * observing registerMessageConnector spy.
 */
import { describe, expect, it } from "vitest";
import truthInventory from "./connector-truth-inventory.json" with {
  type: "json",
};

/**
 * Minimal observing runtime. Registration seams only probe for
 * `registerMessageConnector` (typeof === "function"), the logger, and on the
 * fallback path registerSendHandler; x additionally calls registerPostConnector.
 */
function observingRuntime() {
  const messageRegistrations: Array<Record<string, unknown>> = [];
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000000",
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    registerMessageConnector: (registration: Record<string, unknown>) => {
      messageRegistrations.push(registration);
    },
    registerSendHandler: () => {},
    registerPostConnector: () => {},
    getSetting: () => null,
  };
  return { runtime, messageRegistrations };
}

type InventoryRow = {
  plugin: string;
  registrations: Array<{
    source: string;
    capabilities: string[];
    supportedTargetKinds: string[];
  }>;
};

/** A bare service shell of a plugin Service class, with instance fields set. */
function serviceShell<T extends object>(
  proto: T,
  fields: Record<string, unknown>,
): T {
  const shell = Object.create(proto) as T;
  Object.assign(shell, fields);
  return shell;
}

/** Drive every registration seam and collect what the plugins actually registered. */
async function collectObservedRegistrations(): Promise<
  Map<string, Array<Record<string, unknown>>>
> {
  const bySource = new Map<string, Array<Record<string, unknown>>>();
  const record = (registration: Record<string, unknown>): void => {
    const source = String(registration.source);
    const list = bySource.get(source) ?? [];
    list.push(registration);
    bySource.set(source, list);
  };

  const discord = await import("../../../../plugins/plugin-discord/service");
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const service = serviceShell(discord.DiscordService.prototype, {
      getAccountIds: () => [],
      getDefaultAccountId: () => "default",
      getAccountLabel: () => "Test",
    });
    discord.DiscordService.registerSendHandlers(runtime, service);
    for (const r of messageRegistrations) record(r);
  }

  const instagram = await import(
    "../../../../plugins/plugin-instagram/src/service"
  );
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const accountService = {
      handleSendMessage: async () => {},
      handleSendPost: async () => {},
      getUserByUsername: async () => null,
      getConnectorUserContext: async () => null,
    };
    const service = serviceShell(instagram.InstagramService.prototype, {
      getAccountId: () => "default",
      getAccountService: () => accountService,
      resolveConnectorTargets: () => [],
      listRecentConnectorTargets: async () => [],
      listConnectorRooms: async () => [],
      fetchConnectorMessages: async () => [],
      searchMessages: async () => [],
      getConnectorChatContext: async () => null,
      getConnectorUserContext: async () => null,
    });
    instagram.InstagramService.registerSendHandlers(
      runtime,
      service,
      "default",
    );
    for (const r of messageRegistrations) record(r);
  }

  const x = await import("../../../../plugins/plugin-x/src/services/x.service");
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const service = serviceShell(x.XService.prototype, {
      registerPostConnector: () => {},
    });
    x.XService.registerSendHandlers(runtime, service);
    for (const r of messageRegistrations) record(r);
  }

  const wechat = await import("../../../../plugins/plugin-wechat/src/index");
  {
    const { runtime, messageRegistrations } = observingRuntime();
    wechat.registerWechatMessageConnector(runtime, {}, async () => []);
    for (const r of messageRegistrations) record(r);
  }

  const whatsapp = await import(
    "../../../../plugins/plugin-whatsapp/src/runtime-service"
  );
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const service = serviceShell(whatsapp.WhatsAppConnectorService.prototype, {
      getConnectorAccountIds: () => [],
      resolveAccountId: () => "default",
      getConfigForAccount: () => null,
      connected: false,
      config: null,
    });
    whatsapp.WhatsAppConnectorService.registerSendHandlers(runtime, service);
    for (const r of messageRegistrations) record(r);
  }

  const slack = await import("../../../../plugins/plugin-slack/src/service");
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const service = serviceShell(slack.SlackService.prototype, {
      getDefaultAccountState: () => null,
      getRegisteredAccountIds: () => [],
    });
    slack.SlackService.registerSendHandlers(runtime, service);
    for (const r of messageRegistrations) record(r);
  }

  const telegram = await import(
    "../../../../plugins/plugin-telegram/src/service"
  );
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const service = serviceShell(telegram.TelegramService.prototype, {
      bot: {},
      getAccountIds: () => [],
      getDefaultAccountState: () => null,
    });
    telegram.TelegramService.registerSendHandlers(runtime, service);
    for (const r of messageRegistrations) record(r);
  }

  const matrix = await import("../../../../plugins/plugin-matrix/src/service");
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const service = serviceShell(matrix.MatrixService.prototype, {
      getAccountId: () => "default",
    });
    matrix.MatrixService.registerSendHandlers(runtime, service);
    for (const r of messageRegistrations) record(r);
  }

  const imessage = await import(
    "../../../../plugins/plugin-imessage/src/service"
  );
  {
    // Drive both transport branches: the registration capabilities are
    // transport-conditional (isBlooio gates attachments/contact_resolution off),
    // and the inventory claims one variant per transport configuration.
    const { runtime, messageRegistrations } = observingRuntime();
    const macosStatus = {
      available: false,
      connected: false,
      chatDbAvailable: false,
      sendOnly: false,
      chatDbPath: null,
      reason: "registration-boundary test (macos transport)",
      permissionAction: null,
    };
    const macosService = serviceShell(imessage.IMessageService.prototype, {
      getStatus: () => ({ ...macosStatus, transport: "macos" }),
    });
    imessage.IMessageService.registerSendHandlers(runtime, macosService);
    for (const r of messageRegistrations) record(r);

    const {
      runtime: blooioRuntime,
      messageRegistrations: blooioRegistrations,
    } = observingRuntime();
    const blooioService = serviceShell(imessage.IMessageService.prototype, {
      getStatus: () => ({
        ...macosStatus,
        reason: "registration-boundary test (blooio transport)",
        transport: "blooio",
      }),
    });
    imessage.IMessageService.registerSendHandlers(blooioRuntime, blooioService);
    for (const r of blooioRegistrations) record(r);
  }

  const chat = await import(
    "../../../../plugins/plugin-google-workspace/src/chat/service"
  );
  {
    const { runtime, messageRegistrations } = observingRuntime();
    const service = serviceShell(chat.GoogleChatService.prototype, {
      getAccountId: () => "default",
    });
    chat.GoogleChatService.registerSendHandlers(runtime, service);
    for (const r of messageRegistrations) record(r);
  }

  const gmailProvider = await import(
    "../../../../plugins/plugin-google-workspace/src/connector-account-provider"
  );
  const core = await import("@elizaos/core");
  {
    // Gmail registers through the ConnectorAccountManager provider seam, not
    // a registerSendHandlers call: the plugin's init registers
    // createGoogleConnectorAccountProvider(runtime) and the manager invokes
    // runtime.registerMessageConnector(provider.messageConnector). Drive that
    // real path (same shape as the plugin's own wire-up test) so disabling
    // either the provider wiring or the manager's registration call fails here.
    const { runtime, messageRegistrations } = observingRuntime();
    const managerRuntime = {
      ...runtime,
      getService: () => null,
      getMessageConnectors: () => [],
      getPostConnectors: () => [],
    };
    const manager = core.getConnectorAccountManager(managerRuntime);
    manager.registerProvider(
      gmailProvider.createGoogleConnectorAccountProvider(managerRuntime),
    );
    for (const r of messageRegistrations) record(r);
  }

  return bySource;
}

function setEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((v) => left.has(v));
}

describe("executable registration boundary (#24373)", () => {
  it("backs every inventory channel claim with a seam-executed registration", async () => {
    const observed = await collectObservedRegistrations();
    for (const row of truthInventory.connectors as InventoryRow[]) {
      for (const reg of row.registrations) {
        expect(
          observed.has(reg.source),
          `${row.plugin}: claimed source "${reg.source}" produced NO registration when the plugin's real registration seam executed — the production registerMessageConnector path is disabled or unreachable`,
        ).toBe(true);
      }
    }
  }, 30_000);

  it("pins each transport variant of plugin-imessage's registration exactly", async () => {
    // plugin-imessage declares one registration whose capabilities are
    // transport-conditional (service.ts isBlooio ternary). The inventory row
    // is the UNION of both branches; this test pins each EXECUTED variant's
    // exact capability set so neither branch can silently drift (dropping a
    // capability from only one transport must fail even when the other
    // transport still declares it).
    const observed = await collectObservedRegistrations();
    const variants = (observed.get("imessage") ?? []).map(
      (r) => (r.capabilities as string[] | undefined) ?? [],
    );
    expect(variants.length).toBe(2);
    const macos = [
      "attachments",
      "chat_context",
      "contact_resolution",
      "send_message",
    ];
    const blooio = ["chat_context", "send_message"];
    const shapes = variants.map((caps) => [...caps].sort().join(","));
    expect(shapes).toContain(macos.join(","));
    expect(shapes).toContain(blooio.join(","));
  }, 30_000);

  it("observed registrations carry the claimed capabilities and target kinds", async () => {
    const observed = await collectObservedRegistrations();
    for (const row of truthInventory.connectors as InventoryRow[]) {
      for (const reg of row.registrations) {
        // Inventory rows are sorted; executed registrations arrive in
        // declaration order. Compare as sets — the claim is about WHICH
        // capabilities and target kinds the plugin registers, not their
        // spelling order.
        const live = (observed.get(reg.source) ?? []).find(
          (candidate) =>
            Array.isArray(candidate.capabilities) &&
            setEquals(candidate.capabilities as string[], reg.capabilities) &&
            Array.isArray(candidate.supportedTargetKinds) &&
            setEquals(
              candidate.supportedTargetKinds as string[],
              reg.supportedTargetKinds,
            ),
        );
        expect(
          live,
          `${row.plugin}/${reg.source}: no executed registration carries capabilities ${JSON.stringify(reg.capabilities)} and supportedTargetKinds ${JSON.stringify(reg.supportedTargetKinds)}`,
        ).toBeDefined();
        // Transport-conditional registrations (plugin-imessage declares a
        // blooio branch and a macos branch) must have EVERY executed variant
        // covered by the claimed aggregate: the inventory is the union of the
        // branches, so each observed variant must be a subset of the claim,
        // and the claim must not contain a capability no variant declares.
        for (const candidate of observed.get(reg.source) ?? []) {
          if (!Array.isArray(candidate.capabilities)) continue;
          const variantCaps = candidate.capabilities as string[];
          for (const c of variantCaps) {
            expect(
              reg.capabilities,
              `${row.plugin}/${reg.source}: executed variant declares capability "${c}" missing from the claimed aggregate — extend the inventory, not the test`,
            ).toContain(c);
          }
        }
        for (const c of reg.capabilities) {
          const declaredBySomeVariant = (observed.get(reg.source) ?? []).some(
            (candidate) =>
              Array.isArray(candidate.capabilities) &&
              (candidate.capabilities as string[]).includes(c),
          );
          expect(
            declaredBySomeVariant,
            `${row.plugin}/${reg.source}: claimed capability "${c}" is declared by NO executed registration variant — the inventory overclaims`,
          ).toBe(true);
        }
      }
    }
  }, 30_000);
});
