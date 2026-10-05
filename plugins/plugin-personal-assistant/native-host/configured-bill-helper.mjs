import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

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
  const config = hostPolicy.validateConfiguration(configuration);
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
  const requireProfile = () => {
    if (native.getProfileId() !== config.profileId)
      throw new Error("Configured browser profile unavailable");
  };
  const target = Object.fromEntries(
    ["bindTask", "guideTask", "execute"].map((method) => [
      method,
      async (...args) => {
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
  let host;
  let closing;
  const close = () =>
    (closing ??= (async () => {
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
    })());
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
                requireTask(task);
                const source = config.googleSource;
                return {
                  accountId: source.grantId,
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
      ...hostPolicy.hostOptions({
        config,
        controls,
        requireProfile,
        requireTask,
      }),
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
