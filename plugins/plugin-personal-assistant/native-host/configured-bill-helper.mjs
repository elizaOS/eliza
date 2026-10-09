import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BillHostError } from "./errors.mjs";

/** Configured native bill composition. Trusted host policy supplies authority and evidence schema. */
export async function createConfiguredBillHelper({
  hostPolicy,
  validateBillControls,
  createLabelledBillExtractor,
  createBillHelperHost,
  configuration,
  runtimeModule,
  credentialGate,
  evidenceDirectory,
  environment = process.env,
  onUnavailable = () => {},
  googleReadPort,
  documentRuntime,
  documentImages,
}) {
  const readback =
    hostPolicy.reconcileMethod != null ||
    hostPolicy.reconciliationEvidenceRecord != null;
  if (
    readback &&
    [hostPolicy.reconcileMethod, hostPolicy.reconciliationEvidenceRecord].some(
      (value) => typeof value !== "function",
    )
  )
    throw new BillHostError("Incomplete bill reconciliation policy");
  const config = hostPolicy.validateConfiguration(configuration);
  // Optional emailed sign-in codes: the reviewed provider parser and
  // challenge reader come from host policy; reads use the same Google port.
  const googleCode = hostPolicy.googleCode;
  if (
    googleCode != null &&
    (!config.googleSource ||
      typeof googleCode.challengeForBill !== "function" ||
      typeof googleCode.parse !== "function")
  )
    throw new BillHostError("Incomplete Google verification configuration");
  const controls = validateBillControls(config.controls);
  const extraction = config.googleSource?.extractionProfile
    ? createLabelledBillExtractor(config.googleSource.extractionProfile)
    : null;
  if (
    !isAbsolute(evidenceDirectory) ||
    (config.googleSource && !googleReadPort)
  )
    throw new Error("Invalid configured bill helper inputs");
  if (
    config.googleSource?.pdfModel &&
    (!documentRuntime || typeof documentImages !== "function")
  )
    throw new Error("Configured PDF runtime unavailable");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  const directory = await stat(evidenceDirectory);
  if (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
    throw new Error("Bill evidence directory must be private");
  const native = new runtimeModule.NativeSocketBrowserTarget(() =>
    onUnavailable(),
  );
  const registrationAbort = new AbortController();
  const requireProfile = () => {
    if (native.getProfileId() !== config.profileId)
      throw new Error("Configured browser profile unavailable");
  };
  const target = Object.fromEntries(
    ["bindTask", "guideTask", "execute"].map((method) => [
      method,
      async (...args) => {
        // Wait only before a new binding, never before replaying an effect or
        // revocation cleanup. The actuator fences task revisions around binding.
        if (method === "bindTask" && !args[0]?.revoked) {
          await native.waitForProfile(config.profileId, {
            signal: registrationAbort.signal,
          });
          if (
            (await credentialGate()) !== config.actorId ||
            registrationAbort.signal.aborted
          )
            throw new BillHostError("Configured task authorization changed");
        }
        requireProfile();
        return native[method](...args);
      },
    ]),
  );
  const requireTask = (task) => {
    if (
      task.owner.actorId !== config.actorId ||
      task.goalRef !== config.goalRef
    )
      throw new Error("Unconfigured bill task");
  };
  // A configured grantId is fixed. Otherwise each task epoch reads the Google
  // account that was connected when it first searched, and every read checks
  // that this is still the connected account.
  const grants = new Map();
  const grantForTask = async (task) => {
    requireTask(task);
    if (config.googleSource.grantId) return config.googleSource.grantId;
    const bound = grants.get(task.id);
    if (bound?.epoch === task.epoch) return bound.accountId;
    if (typeof googleReadPort.currentAccountId !== "function")
      throw new BillHostError("Google account binding unavailable");
    const accountId = await googleReadPort.currentAccountId();
    const current = grants.get(task.id);
    if (current?.epoch === task.epoch) return current.accountId;
    grants.set(task.id, { epoch: task.epoch, accountId });
    return accountId;
  };
  let host;
  let closing;
  const close = () => {
    registrationAbort.abort();
    closing ??= (async () => {
      const errors = [];
      try {
        await host?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await native.stop();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, "Configured helper cleanup failed");
    })();
    return closing;
  };
  try {
    host = createBillHelperHost({
      runtimeModule,
      target,
      credentialGate,
      controls,
      ...(config.googleSource
        ? {
            billDiscovery: {
              google: googleReadPort,
              parse: extraction?.parseMessage ?? hostPolicy.parseMessage,
              ...(config.googleSource.pdfModel
                ? {
                    pdf: {
                      pdfService: new documentRuntime.PdfService({
                        useModel: async (type, params) => {
                          if (type !== "IMAGE_DESCRIPTION")
                            throw new Error("Unsupported document model");
                          return documentImages(params);
                        },
                      }),
                      mapDocument:
                        extraction?.parseDocument ?? hostPolicy.parseDocument,
                    },
                  }
                : {}),
              scopeForTask: async (task) => {
                const source = config.googleSource;
                return {
                  accountId: await grantForTask(task),
                  billingAccountRef: source.billingAccountRef,
                  recipient: source.recipient,
                  senders: source.senders,
                  searchQuery: source.query,
                  after: source.after,
                  before: source.before,
                  company: config.bill.company,
                  accountLabel: config.bill.accountLabel,
                  providerOrigin: config.bill.origin,
                };
              },
            },
          }
        : {}),
      ...(googleCode
        ? {
            google: {
              service: googleReadPort,
              parse: googleCode.parse,
              challengeForBill: googleCode.challengeForBill,
              accountForTask: grantForTask,
            },
          }
        : {}),
      ...hostPolicy.hostOptions({
        config,
        controls,
        requireProfile,
        requireTask,
      }),
      ...(readback
        ? {
            reconcileMethod: async (input) => {
              requireTask(input.task);
              const result = await hostPolicy.reconcileMethod(input);
              requireTask(input.task);
              if (result?.status === "unknown") return { status: "unknown" };
              if (!["succeeded", "failed"].includes(result?.status))
                throw new BillHostError("Invalid bill reconciliation result");
              const id = randomUUID();
              const record = hostPolicy.reconciliationEvidenceRecord({
                ...input,
                status: result.status,
              });
              await writeFile(
                join(evidenceDirectory, `${id}.json`),
                `${JSON.stringify(record)}\n`,
                { mode: 0o600, flag: "wx" },
              );
              return {
                status: result.status,
                evidenceRef: `${hostPolicy.evidenceNamespace}:${id}`,
              };
            },
          }
        : {}),
      recordEvidence: async (task, proposal, before, after, status) => {
        requireTask(task);
        const id = randomUUID();
        const record = hostPolicy.evidenceRecord({
          task,
          proposal,
          before,
          after,
          status,
        });
        await writeFile(
          join(evidenceDirectory, `${id}.json`),
          `${JSON.stringify(record)}\n`,
          { mode: 0o600, flag: "wx" },
        );
        return `${hostPolicy.evidenceNamespace}:${id}`;
      },
    });
    await native.start(environment);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Configured helper startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
  return {
    ...host,
    async describeHelper(owner) {
      if (
        closing ||
        owner.actorId !== config.actorId ||
        (await credentialGate()) !== config.actorId ||
        closing ||
        native.getProfileId() !== config.profileId
      )
        return null;
      return hostPolicy.describeHelper(config);
    },
    close,
  };
}
