import axios from "axios";
import {
	PHALA_CLOUD_API_URL,
	CLI_VERSION,
	CLOUD_URL,
} from "@/src/tee/phala/constants";
import { getApiKey } from "@/src/tee/phala/credential";
import type {
	CreateCvmResponse,
	GetPubkeyFromCvmResponse,
	GetCvmByAppIdResponse,
	GetUserInfoResponse,
	UpgradeCvmResponse,
	GetCvmsByUserIdResponse,
} from "@/src/tee/phala/types";

const headers = {
	"User-Agent": `tee-cli/${CLI_VERSION}`,
	"Content-Type": "application/json",
};

let apiKey: string | null = null;

const retrieveApiKey = async () => {
	if (apiKey) {
		return apiKey;
	}

	apiKey = await getApiKey();
	if (!apiKey) {
		console.error("Error: API key not found. Please set an API key first.");
		process.exit(1);
	}
	return apiKey;
};

function wrapText(text: string, maxWidth: number): string[] {
	if (!text) return [""];

	// Handle case where a single word is longer than maxWidth
	if (text.length <= maxWidth) return [text];

	const lines: string[] = [];
	let currentLine = "";

	// Split by any whitespace and preserve URLs
	const words = text.split(/(\s+)/).filter((word) => word.trim().length > 0);

	for (const word of words) {
		// If the word itself is longer than maxWidth, split it
		if (word.length > maxWidth) {
			if (currentLine) {
				lines.push(currentLine);
				currentLine = "";
			}
			for (let i = 0; i < word.length; i += maxWidth) {
				lines.push(word.slice(i, i + maxWidth));
			}
			continue;
		}

		// If adding the word would exceed maxWidth
		if (currentLine.length + word.length + 1 > maxWidth) {
			lines.push(currentLine);
			currentLine = word;
		} else {
			// Add word to current line
			currentLine = currentLine ? `${currentLine} ${word}` : word;
		}
	}

	if (currentLine) {
		lines.push(currentLine);
	}

	return lines;
}

function getTerminalWidth(): number {
	return process.stdout.columns || 80; // Default to 80 if width cannot be determined
}

function calculateColumnWidths(cvms: GetCvmsByUserIdResponse): {
	[key: string]: number;
} {
	const terminalWidth = getTerminalWidth();

	// Account for all border characters in total width ("|" at start/end and between columns, plus 2 spaces per column)
	const totalBorderWidth = 13; // | + 4 columns with "| " and " |" = 1 + 4 * 3 = 13
	const availableContentWidth = terminalWidth - totalBorderWidth;

	// Calculate the maximum content width for dynamic columns (name and status)
	const contentWidths = {
		name: Math.max(
			10,
			"Agent Name".length,
			...cvms.map((cvm) => cvm.hosted.name.length),
		),
		status: Math.max(
			6,
			"Status".length,
			...cvms.map((cvm) => cvm.hosted.status.length),
		),
	};

	// Calculate remaining width for App ID and App URL
	const remainingWidth = Math.max(
		0,
		availableContentWidth - contentWidths.name - contentWidths.status,
	);

	// Split remaining width between App ID (1/3) and App URL (2/3)
	const appIdWidth = Math.max(8, Math.floor(remainingWidth * 0.33));
	const appUrlWidth = Math.max(7, remainingWidth - appIdWidth);

	// If total width would exceed terminal, scale everything down proportionally
	const totalWidth =
		contentWidths.name +
		contentWidths.status +
		appIdWidth +
		appUrlWidth +
		totalBorderWidth;
	if (totalWidth > terminalWidth) {
		const scale = availableContentWidth / (totalWidth - totalBorderWidth);
		return {
			name: Math.max(10, Math.floor(contentWidths.name * scale)),
			status: Math.max(6, Math.floor(contentWidths.status * scale)),
			appId: Math.max(8, Math.floor(appIdWidth * scale)),
			appUrl: Math.max(7, Math.floor(appUrlWidth * scale)),
		};
	}

	return {
		name: contentWidths.name,
		status: contentWidths.status,
		appId: appIdWidth,
		appUrl: appUrlWidth,
	};
}

function formatCvmsTable(cvms: GetCvmsByUserIdResponse): void {
	const columnWidths = calculateColumnWidths(cvms);

	// Create header separator
	const separator = `+-${"-".repeat(columnWidths.name)}-+-${"-".repeat(columnWidths.status)}-+-${"-".repeat(columnWidths.appId)}-+-${"-".repeat(columnWidths.appUrl)}-+`;

	// Print header
	console.log(separator);
	console.log(
		`| ${"Agent Name".padEnd(columnWidths.name)} | ${"Status".padEnd(columnWidths.status)} | ${"App ID".padEnd(columnWidths.appId)} | ${"App URL".padEnd(columnWidths.appUrl)} |`,
	);
	console.log(separator);

	// Print rows with wrapped text
	cvms.forEach((cvm) => {
		const nameLines = wrapText(cvm.hosted.name, columnWidths.name);
		const statusLines = wrapText(cvm.hosted.status, columnWidths.status);
		const appIdLines = wrapText(cvm.hosted.app_id, columnWidths.appId);
		const appUrlLines = wrapText(cvm.hosted.app_url, columnWidths.appUrl);

		// Get the maximum number of lines needed for this row
		const maxLines = Math.max(
			nameLines.length,
			statusLines.length,
			appIdLines.length,
			appUrlLines.length,
		);

		// Print each line of the row
		for (let i = 0; i < maxLines; i++) {
			console.log(
				`| ${(nameLines[i] || "").padEnd(columnWidths.name)} | ` +
					`${(statusLines[i] || "").padEnd(columnWidths.status)} | ` +
					`${(appIdLines[i] || "").padEnd(columnWidths.appId)} | ` +
					`${(appUrlLines[i] || "").padEnd(columnWidths.appUrl)} |`,
			);
		}

		// Add a separator after each row
		console.log(separator);
	});

	// Print total count
	console.log(`\nTotal CVMs: ${cvms.length}`);
}

async function queryTeepods(): Promise<any> {
	try {
		const response = await axios.get(`${PHALA_CLOUD_API_URL}/api/v1/teepods`, {
			headers: { ...headers, "X-API-Key": await retrieveApiKey() },
		});
		return response.data;
	} catch (error: any) {
		console.error(
			"Error during teepod query:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function queryImages(teepodId: string): Promise<any> {
	try {
		const response = await axios.get(
			`${PHALA_CLOUD_API_URL}/api/v1/teepods/${teepodId}/images`,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		return response.data;
	} catch (error: any) {
		console.error(
			"Error during image query:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function queryCvmsByUserId(): Promise<GetCvmsByUserIdResponse | null> {
	try {
		const userInfo = await getUserInfo();
		const response = await axios.get(
			`${PHALA_CLOUD_API_URL}/api/v1/cvms?user_id=${userInfo?.id}`,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		return response.data as GetCvmsByUserIdResponse;
	} catch (error: any) {
		console.error(
			"Error during get cvms by user id:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function createCvm(vm_config: any): Promise<CreateCvmResponse | null> {
	try {
		const response = await axios.post(
			`${PHALA_CLOUD_API_URL}/api/v1/cvms/from_cvm_configuration`,
			vm_config,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		return response.data as CreateCvmResponse;
	} catch (error: any) {
		console.error(
			"Error during create cvm:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function getPubkeyFromCvm(
	vm_config: any,
): Promise<GetPubkeyFromCvmResponse | null> {
	try {
		const response = await axios.post(
			`${PHALA_CLOUD_API_URL}/api/v1/cvms/pubkey/from_cvm_configuration`,
			vm_config,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		return response.data as GetPubkeyFromCvmResponse;
	} catch (error: any) {
		console.error(
			"Error during get pubkey from cvm:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function getCvmByAppId(
	appId: string,
): Promise<GetCvmByAppIdResponse | null> {
	try {
		const response = await axios.get(
			`${PHALA_CLOUD_API_URL}/api/v1/cvms/app_${appId}`,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		return response.data as GetCvmByAppIdResponse;
	} catch (error: any) {
		console.error(
			"Error during get cvm by app id:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function getUserInfo(): Promise<GetUserInfoResponse | null> {
	try {
		const getUserAuth = await axios.get(
			`${PHALA_CLOUD_API_URL}/api/v1/auth/me`,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		const username = getUserAuth.data.username;
		const getUserId = await axios.get(
			`${PHALA_CLOUD_API_URL}/api/v1/users/search?q=${username}`,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		const userId = getUserId.data.users[0].id;
		return { id: userId, username: username };
	} catch (error: any) {
		console.error(
			"Error during get user info:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function upgradeCvm(
	appId: string,
	vm_config: any,
): Promise<UpgradeCvmResponse | null> {
	try {
		const response = await axios.put(
			`${PHALA_CLOUD_API_URL}/api/v1/cvms/app_${appId}/compose`,
			vm_config,
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		return response.data as UpgradeCvmResponse;
	} catch (error: any) {
		console.error(
			"Error during upgrade cvm:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function startCvm(appId: string): Promise<any> {
	try {
		const response = await axios.post(
			`${PHALA_CLOUD_API_URL}/api/v1/cvms/app_${appId}/start`,
			{ app_id: appId },
			{
				headers: { ...headers, "X-API-Key": await retrieveApiKey() },
			},
		);
		return response.data;
	} catch (error: any) {
		console.error(
			"Error during start cvm:",
			error.response?.data || error.message,
		);
		return null;
	}
}

async function listCvms(): Promise<void> {
	console.log("Fetching your CVMs...");
	const cvms = await queryCvmsByUserId();

	if (!cvms || cvms.length === 0) {
		console.log("No CVMs found for your account.");
		return;
	}

	formatCvmsTable(cvms);
}

export {
	createCvm,
	queryTeepods,
	queryImages,
	getPubkeyFromCvm,
	getCvmByAppId,
	getUserInfo,
	upgradeCvm,
	startCvm,
	queryCvmsByUserId,
	listCvms,
};
