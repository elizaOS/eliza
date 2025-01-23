import { spawn } from "node:child_process";
import { stringToUuid } from "../packages/core/dist/index.js";
import path from "path";

export const DEFAULT_CHARACTER = "trump";
export const DEFAULT_AGENT_ID = stringToUuid(DEFAULT_CHARACTER ?? uuidv4());

function projectRoot() {
    return path.join(import.meta.dirname, "..");
    // return "/Users/piotr/Documents/GitHub/Sifchain/eliza"
}

function log(message) {
    console.log(message);
}

function logError(error) {
    log("ERROR: " + error.message);
    log(error); // Print stack trace
}

async function runProcess(command, args = [], directory = projectRoot()) {
    try {
        return new Promise((resolve, reject) => {
            const process = spawn(command, args, {
                cwd: directory,
                shell: true,
                stdio: ['inherit', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            process.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            process.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            process.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    reject(new Error(`Command failed with code ${code}: ${stderr}`));
                }
            });

            process.on('error', (error) => {
                reject(new Error(`Failed to start command: ${error.message}`));
            });
        });
    } catch (error) {
        throw new Error(`Command failed: ${error.message}`);
    }
}

async function installProjectDependencies() {
    log("Installing dependencies...");
    return await runProcess("pnpm", ["install", "-r"]);
}

async function buildProject() {
    log("Building project...");
    return await runProcess("pnpm", ["build"]);
}

async function writeEnvFile(entries) {
    const envContent = Object.entries(entries)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
    await fs.writeFile(".env", envContent);
}

async function startAgent(character = DEFAULT_CHARACTER) {
    log(`Starting agent for character: ${character}`);
    const proc = spawn(
        "node",
        [
            "--loader",
            "ts-node/esm",
            "src/index.ts",
            "--isRoot",
            `--character=characters/${character}.character.json`,
            "--non-interactive",
        ],
        {
            cwd: path.join(projectRoot(), "agent"),
            shell: false,
            stdio: "inherit",
        }
    );
    const startTime = Date.now();
    while (true) {
        try {
            const response = await fetch("http://127.0.0.1:3000/", {
                method: "GET",
            });
            if (response.ok) break;
        } catch (error) {}
        if (Date.now() - startTime > 120000) {
            throw new Error("Timeout waiting for process to start");
        } else {
            await sleep(1000);
        }
    }
    await sleep(1000);
    return proc;
}

async function stopAgent(proc) {
    log("Stopping agent..." + JSON.stringify(proc.pid));
    proc.kill();
    const startTime = Date.now();
    while (true) {
        if (proc.killed) break;
        if (Date.now() - startTime > 60000) {
            throw new Error("Timeout waiting for the process to terminate");
        }
        await sleep(1000);
    }
    await sleep(1000);
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPostRequest(url, method, payload) {
    try {
        const response = await fetch(url, {
            method: method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!response.ok)
            throw new Error(`HTTP error! status: ${response.status}`);
        const data = await response.json();
        return data;
    } catch (error) {
        throw new Error(`Failed to send message: ${error.message}`);
    }
}

async function send(message) {
    const url = `http://127.0.0.1:3000/${DEFAULT_AGENT_ID}/message`;
    return await sendPostRequest(url, "POST", {
        text: message,
        userId: "user",
        userName: "User",
    });
}

async function runIntegrationTest(fn) {
    log(fn);
    const skip = fn.hasOwnProperty("skipIf") ? fn.skipIf : false;
    if (skip) {
        log(
            fn.description
                ? `Skipping test ${fn.description}...`
                : "Skipping test..."
        );
    } else {
        log(
            fn.description
                ? `Running test ${fn.description}...`
                : "Running test..."
        );
        const proc = await startAgent();
        try {
            await fn();
            log(
                fn.description
                    ? `✓ Test ${fn.description} passed`
                    : "✓ Test passed"
            );
        } catch (error) {
            log(
                fn.description
                    ? `✗ Test ${fn.description} failed`
                    : "✗ Test failed"
            );
            logError(error);
        } finally {
            await stopAgent(proc);
        }
    }
}

export {
    projectRoot,
    runProcess,
    installProjectDependencies,
    buildProject,
    writeEnvFile,
    startAgent,
    stopAgent,
    send,
    runIntegrationTest,
    log,
    logError,
    sleep,
};
