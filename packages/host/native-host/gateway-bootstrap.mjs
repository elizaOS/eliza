import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { startGatewayLifecycle } from "./gateway-lifecycle.mjs";

const validPort = (port) =>
  Number.isInteger(port) && port >= 1024 && port <= 65535;
/** Explicit local/native bootstrap. Hosts select paths, factories and authority policy. */
export async function startLocalGateway({
  configuration: config,
  ports,
  onCleanupError,
}) {
  if (config.native && !isAbsolute(config.root))
    throw new Error("Native runtime state must be an absolute path");
  if (!validPort(config.port) || (config.native && !config.upstream))
    throw new Error("Invalid native gateway endpoint");
  if (
    config.requireInboundToken !== undefined &&
    typeof config.requireInboundToken !== "boolean"
  )
    throw new Error("Invalid inbound token policy");
  const token = (await readFile(config.tokenPath, "utf8")).trim();
  // Native hosts always require the inbound token. A desktop host can opt in,
  // so every local request must carry it there too.
  const requireInbound = config.native || config.requireInboundToken === true;
  const inboundToken = requireInbound
    ? (await readFile(config.inboundTokenPath, "utf8")).trim()
    : undefined;
  if (requireInbound && (!inboundToken || inboundToken.length < 32))
    throw new Error(
      config.native ? "Native gateway token missing" : "Gateway token missing",
    );
  if (
    config.native &&
    (!validPort(config.credentialBroker?.port) ||
      typeof config.credentialBroker?.token !== "string" ||
      config.credentialBroker.token.length < 32)
  )
    throw new Error("Native credential broker unavailable");
  const store = config.native
    ? ports.createLocalCredentialStore(config.credentialBroker)
    : ports.createFileCredentialStore(config.credentialPath);
  const readBinding = async () => {
    try {
      return JSON.parse(await readFile(config.bindingPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const credentialGate = ports.createCredentialGate({
    verifyProcess: !config.native,
    readCredential: store.read,
    readBinding,
  });
  if (!config.native) await ports.buildTaskRuntime(config.bundlePath);
  const cloudHandler = ports.createCloudRoutes({
    credentialStore: store,
    credentialGate,
  });
  const inferenceConfigured = config.native
    ? async () => {
        await credentialGate();
        const binding = JSON.parse(await readFile(config.bindingPath, "utf8"));
        return binding.inferenceConfigured === true;
      }
    : undefined;
  return startGatewayLifecycle({
    createHelper: () =>
      ports.createHelper?.({
        bundlePath: config.bundlePath,
        cloudHandler,
        credentialGate,
      }),
    createTaskGateway: (helper) =>
      ports.createTaskGateway({
        ...helper,
        bundlePath: config.bundlePath,
        databasePath: config.databasePath,
        credentialGate,
      }),
    startCapture: ports.startCapture,
    createReputation: ports.createReputation,
    createServer: ({ taskGateway, reputation }) =>
      ports.createServer({
        websiteReputation: reputation,
        upstream: config.upstream,
        token,
        inboundToken,
        credentialGate,
        taskGateway,
        inferenceConfigured,
        ownershipStore: ports.createFileCredentialStore(config.ownershipPath),
        cloudHandler,
      }),
    port: config.port,
    onCleanupError,
  });
}
