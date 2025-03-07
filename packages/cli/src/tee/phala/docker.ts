import { exec } from "node:child_process";
import { promisify } from "node:util";
import axios from "axios";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Handlebars from "handlebars";
import { spawn } from "node:child_process";
import {
	DOCKER_COMPOSE_ELIZA_V1_TEMPLATE,
	DOCKER_COMPOSE_ELIZA_V2_TEMPLATE,
	COMPOSE_FILES_DIR,
} from "./constants";

const execAsync = promisify(exec);
const LOGS_DIR = ".tee-cloud/logs";
const MAX_CONSOLE_LINES = 10;

export class DockerOperations {
	private imageName: string;
	private dockerHubUsername?: string;

	constructor(imageName: string, dockerHubUsername?: string) {
		this.imageName = imageName;
		this.dockerHubUsername = dockerHubUsername;
		this.ensureLogsDir();
	}

	private ensureLogsDir(): void {
		const logsPath = path.resolve(LOGS_DIR);
		if (!fs.existsSync(logsPath)) {
			fs.mkdirSync(logsPath, { recursive: true });
		}
	}

	private getLogFilePath(operation: string): string {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		return path.resolve(
			LOGS_DIR,
			`${this.imageName}-${operation}-${timestamp}.log`,
		);
	}

	private getSystemArchitecture(): string {
		const arch = os.arch();
		switch (arch) {
			case "arm":
			case "arm64":
				return "arm64";
			case "x64":
				return "amd64";
			default:
				return arch;
		}
	}

	private spawnProcess(
		command: string,
		args: string[],
		operation: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const proc = spawn(command, args);
			const logFile = this.getLogFilePath(operation);
			const logStream = fs.createWriteStream(logFile, { flags: "a" });
			const consoleBuffer: string[] = [];

			const processOutput = (data: Buffer, isError = false) => {
				const lines = data.toString().split("\n");

				// Write to log file
				logStream.write(data);

				// Update console buffer
				lines.forEach((line) => {
					if (line.trim()) {
						consoleBuffer.push(line);
						// Keep only the last MAX_CONSOLE_LINES lines
						if (consoleBuffer.length > MAX_CONSOLE_LINES) {
							consoleBuffer.shift();
						}

						// Clear console and print the buffer
						console.clear();
						console.log(
							`Latest ${MAX_CONSOLE_LINES} lines (full log at ${logFile}):`,
						);
						console.log("-".repeat(50));
						consoleBuffer.forEach((bufferedLine) => {
							if (isError) {
								console.error(bufferedLine);
							} else {
								console.log(bufferedLine);
							}
						});
					}
				});
			};

			proc.stdout.on("data", (data) => processOutput(data));
			proc.stderr.on("data", (data) => processOutput(data, true));

			proc.on("close", (code) => {
				logStream.end();
				if (code === 0) {
					console.log(
						`\nOperation completed. Full log available at: ${logFile}`,
					);
					resolve();
				} else {
					reject(
						new Error(
							`Process exited with code ${code}. Check log file: ${logFile}`,
						),
					);
				}
			});

			proc.on("error", (err) => {
				logStream.end();
				reject(err);
			});
		});
	}

	async buildImage(dockerfilePath: string, tag: string): Promise<void> {
		try {
			if (!this.dockerHubUsername) {
				throw new Error("Docker Hub username is required for building");
			}

			const arch = this.getSystemArchitecture();
			const fullImageName = `${this.dockerHubUsername}/${this.imageName}:${tag}`;
			console.log(`Building Docker image ${fullImageName}...`);

			const buildArgs = ["build", "-t", fullImageName, "-f", dockerfilePath];

			if (arch === "arm64") {
				console.log(
					"Detected arm64 architecture, using --platform linux/amd64",
				);
				buildArgs.push("--platform", "linux/amd64");
			}

			buildArgs.push(".");

			await this.spawnProcess("docker", buildArgs, "build");
			console.log(`Docker image ${fullImageName} built successfully.`);
		} catch (error) {
			console.error("Error building Docker image:", error);
			throw error;
		}
	}

	async pushToDockerHub(tag: string): Promise<void> {
		if (!this.dockerHubUsername) {
			throw new Error("Docker Hub username is required for publishing");
		}

		try {
			const fullImageName = `${this.dockerHubUsername}/${this.imageName}:${tag}`;
			console.log(`Pushing image ${fullImageName} to Docker Hub...`);

			await this.spawnProcess("docker", ["push", fullImageName], "push");
			console.log(`Successfully pushed ${fullImageName} to Docker Hub`);
		} catch (error) {
			console.error("Error pushing to Docker Hub:", error);
			throw error;
		}
	}

	async listPublishedTags(): Promise<string[]> {
		if (!this.dockerHubUsername) {
			throw new Error("Docker Hub username is required for querying images");
		}

		try {
			console.log(
				`Querying tags for ${this.dockerHubUsername}/${this.imageName}...`,
			);
			const response = await axios.get(
				`https://hub.docker.com/v2/repositories/${this.dockerHubUsername}/${this.imageName}/tags`,
			);

			if (response.data?.results) {
				return response.data.results.map((tag: any) => tag.name);
			}
			return [];
		} catch (error) {
			console.error("Error querying Docker Hub:", error);
			throw error;
		}
	}

	async runSimulator(image: string): Promise<void> {
		try {
			console.log("Pulling latest simulator image...");
			await execAsync(`docker pull ${image}`);

			console.log("Starting simulator in background...");
			const { stdout } = await execAsync(
				`docker run -d --rm -p 8090:8090 ${image}`,
			);
			const containerId = stdout.trim();

			console.log("\nSimulator started successfully!");
			console.log(`Container ID: ${containerId}`);
			console.log("\nUseful commands:");
			console.log(`- View logs: docker logs -f ${containerId}`);
			console.log(`- Stop simulator: docker stop ${containerId}`);
			console.log("\nSimulator is running on http://localhost:8090");
		} catch (error) {
			console.error("Error running simulator:", error);
			throw error;
		}
	}

	private ensureComposeDir(): string {
		const composePath = path.resolve(COMPOSE_FILES_DIR);
		if (!fs.existsSync(composePath)) {
			fs.mkdirSync(composePath, { recursive: true });
		}
		return composePath;
	}

	async buildComposeFile(
		tag: string,
		characterName: string,
		envFile: string,
		version = "v2",
	): Promise<string> {
		if (!this.dockerHubUsername) {
			throw new Error(
				"Docker Hub username is required for building compose file",
			);
		}

		// Ensure compose files directory exists
		const composePath = this.ensureComposeDir();

		// Parse env file to get variable names
		const envContent = fs.readFileSync(envFile, "utf-8");
		const envVars = envContent
			.split("\n")
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => line.trim())
			.filter((line) => line.includes("="))
			.map((line) => {
				const key = line.split("=")[0].trim();
				return `${key}=${key}`; // Just create KEY=KEY format
			});

		// Get base name of character file without extension
		let characterBaseName = "";
		let characterBase64Data = "";
		if (version === "v1") {
			characterBaseName = path.basename(
				characterName,
				path.extname(characterName),
			);
			characterBase64Data = fs.readFileSync(characterName, "base64");
		} else {
			characterBaseName = characterName;
		}

		// Select template based on version
		const template =
			version === "v1"
				? DOCKER_COMPOSE_ELIZA_V1_TEMPLATE
				: DOCKER_COMPOSE_ELIZA_V2_TEMPLATE;

		// Create full image name with username
		const fullImageName = `${this.dockerHubUsername}/${this.imageName}`;

		// Compile template with data
		const compiledTemplate = Handlebars.compile(template, { noEscape: true });
		const composeContent = compiledTemplate({
			imageName: fullImageName,
			tag,
			characterName: characterBaseName,
			characterBase64Data: characterBase64Data,
			envVars: envVars.map((env) =>
				env.replace(/=.*/, `=\${${env.split("=")[0]}}`),
			),
		});

		// Write the docker-compose file with standardized name in the compose directory
		const composeFile = path.join(
			composePath,
			`${characterBaseName}-tee-compose.yaml`,
		);
		fs.writeFileSync(composeFile, composeContent, { flag: "w" });

		console.log(`Docker compose file created at: ${composeFile}`);
		return composeFile;
	}

	async runLocalCompose(composeFile: string, envFile: string): Promise<void> {
		try {
			console.log(
				`Starting local environment using compose file: ${composeFile}...`,
			);
			// Pass the env file to docker-compose
			await execAsync(
				`docker-compose --env-file ${path.resolve(envFile)} -f ${composeFile} up -d`,
			);

			console.log("\nLocal environment started successfully!");
			console.log("\nUseful commands:");
			console.log(`- View logs: docker-compose -f ${composeFile} logs -f`);
			console.log(`- Stop services: docker-compose -f ${composeFile} down`);
			console.log(`- Compose file location: ${composeFile}`);
		} catch (error) {
			console.error("Error running local environment:", error);
			throw error;
		}
	}

	async runLocal(
		tag: string,
		characterName: string,
		envFile: string,
		version = "v2",
	): Promise<void> {
		try {
			const composeFile = await this.buildComposeFile(
				tag,
				characterName,
				envFile,
				version,
			);
			await this.runLocalCompose(composeFile, envFile);
		} catch (error) {
			console.error("Error in runLocal:", error);
			throw error;
		}
	}
}
