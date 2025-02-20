import Docker from "dockerode";
import path from "path";
import fs from "fs";

const docker = new Docker();

// Utility to create directories if they don't exist
const createDirectory = (directoryPath: string): void => {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
    console.log(`Created directory: ${directoryPath}`);
  }
};

// Class for running a Relayer
export class RelayerRunner {
  private relayChains: string[];
  private relayerKey: string;
  private configFilePath: string;
  private relayerDbPath: string;
  private validatorSignaturesDir: string;
  private containerId: string | null = null;

  constructor(relayChains: string[], relayerKey: string, configFilePath: string, validatorChainName: string) {
    this.relayChains = relayChains;
    this.relayerKey = relayerKey;
    this.configFilePath = configFilePath;
    this.relayerDbPath = path.resolve("hyperlane_db_relayer");
    this.validatorSignaturesDir = path.resolve(`tmp/hyperlane-validator-signatures-${validatorChainName}`);

    // Ensure required directories exist
    createDirectory(this.relayerDbPath);
  }

  async run(): Promise<void> {
    try {
      console.log(`Pulling latest Hyperlane agent Docker image...`);
      await docker.pull("gcr.io/abacus-labs-dev/hyperlane-agent:agents-v1.1.0", (err, stream) => {
        if (err) {
          console.error("Error pulling Docker image:", err);
          return;
        }
        docker.modem.followProgress(stream, onFinished, onProgress);

        function onFinished(err?: Error) {
          if (err) {
            console.error("Error pulling Docker image:", err);
          } else {
            console.log("Docker image pulled successfully.");
          }
        }

        function onProgress(event: any) {
          console.log("Downloading Docker image...", event);
        }
      });

      console.log(`Creating container for relayer on chains: ${this.relayChains.join(", ")}...`);
      const container = await docker.createContainer({
        Image: "gcr.io/abacus-labs-dev/hyperlane-agent:agents-v1.1.0",
        Env: [`CONFIG_FILES=/config/agent-config.json`],
        HostConfig: {
          Mounts: [
            {
              Source: path.resolve(this.configFilePath),
              Target: "/config/agent-config.json",
              Type: "bind",
              ReadOnly: true,
            },
            {
              Source: this.relayerDbPath,
              Target: "/hyperlane_db",
              Type: "bind",
            },
            {
              Source: this.validatorSignaturesDir,
              Target: "/tmp/validator-signatures",
              Type: "bind",
              ReadOnly: true,
            },
          ],
        },
        Cmd: [
          "./relayer",
          "--db",
          "/hyperlane_db",
          "--relayChains",
          this.relayChains.join(","),
          "--allowLocalCheckpointSyncers",
          "true",
          "--defaultSigner.key",
          this.relayerKey,
        ],
        Tty: true,
      });

      this.containerId = container.id;

      console.log(`Starting relayer for chains: ${this.relayChains.join(", ")}...`);
      await container.start();
      console.log(`Relayer for chains: ${this.relayChains.join(", ")} started successfully.`);

      console.log("Fetching container logs...");
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
      });
      logStream.on("data", (chunk) => {
        console.log(chunk.toString());
      });

      console.log("Relayer is now running. Monitoring logs...");
    } catch (error) {
      console.error(`Error starting relayer for chains: ${this.relayChains.join(", ")}`, error);
    }
  }

  async checkStatus(): Promise<void> {
    try {
      const containers = await docker.listContainers({ all: true });
      const runningContainer = containers.find((c) => c.Id === this.containerId);
      if (runningContainer) {
        console.log(`Relayer container is running: ${runningContainer.Id}`);
      } else {
        console.log("Relayer container is not running.");
      }
    } catch (error) {
      console.error("Error checking container status:", error);
    }
  }
}
