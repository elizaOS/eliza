import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let intifaceProcess: ChildProcess | null = null;

export async function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net
            .createServer()
            .once("error", () => resolve(false))
            .once("listening", () => {
                server.close();
                resolve(true);
            })
            .listen(port);
    });
}

export async function startIntifaceEngine(): Promise<void> {
    const configPath = path.join(
        __dirname,
        "../src/intiface-user-device-config.json"
    );
    try {
        const child = spawn(
            path.join(__dirname, "../intiface-engine/intiface-engine"),
            [
                "--websocket-port",
                "12345",
                "--use-bluetooth-le",
                "--server-name",
                "Eliza Intiface Server",
                "--use-device-websocket-server",
                "--user-device-config-file",
                configPath,
            ],
            {
                detached: false,
                stdio: "ignore",
                windowsHide: true,
            }
        );

        child.unref();
        intifaceProcess = child;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        console.log("[utils] Intiface Engine started");
    } catch (error) {
        throw new Error(`Failed to start Intiface Engine: ${error}`);
    }
}

async function cleanup() {
    if (intifaceProcess) {
        console.log("[utils] Shutting down Intiface Engine...");
        try {
            // Try graceful shutdown first
            intifaceProcess.kill("SIGTERM");

            // Give it a moment to shut down gracefully
            await new Promise((r) => setTimeout(r, 1000));

            // Force kill if still running
            if (intifaceProcess.killed === false) {
                try {
                    const killCommand =
                        process.platform === "win32"
                            ? spawn("taskkill", [
                                  "/F",
                                  "/IM",
                                  "intiface-engine.exe",
                              ])
                            : spawn("pkill", ["intiface-engine"]);

                    await new Promise((resolve) => {
                        killCommand.on("close", resolve);
                    });
                } catch (killErr) {
                    console.error(
                        "[utils] Error force killing Intiface Engine:",
                        killErr
                    );
                }
            }
        } catch (err) {
            console.error(
                "[utils] Error during Intiface Engine shutdown:",
                err
            );
        } finally {
            intifaceProcess = null;
        }
    }
}

// Export cleanup for manual shutdown if needed
export { cleanup as shutdownIntifaceEngine };
