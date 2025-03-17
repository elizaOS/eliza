import { CLI_VERSION, CLOUD_URL, PHALA_CLOUD_API_URL } from '@/src/tee/phala/constants';
import { getApiKey } from '@/src/tee/phala/credential';
import type {
  CreateCvmResponse,
  GetCvmByAppIdResponse,
  GetCvmsByUserIdResponse,
  GetPubkeyFromCvmResponse,
  GetUserInfoResponse,
  UpgradeCvmResponse,
} from '@/src/tee/phala/types';
import axios from 'axios';

const headers = {
  'User-Agent': `tee-cli/${CLI_VERSION}`,
  'Content-Type': 'application/json',
};

/**
 * Variable apiKey to store the API key.
 * @type {string | null}
 */
let apiKey: string | null = null;

/**
 * Retrieves the API key either from a cache or by asynchronously fetching it using `getApiKey` function.
 * If the API key is not found, an error is logged and the process exits with code 1.
 * @returns {string} The retrieved API key.
 */
const retrieveApiKey = async () => {
  if (apiKey) {
    return apiKey;
  }

  apiKey = await getApiKey();
  if (!apiKey) {
    console.error('Error: API key not found. Please set an API key first.');
    process.exit(1);
  }
  return apiKey;
};

/**
 * Wrap the input text to fit within the specified maxWidth by breaking the text into lines.
 *
 * @param {string} text - The text to wrap.
 * @param {number} maxWidth - The maximum width for each line.
 * @returns {string[]} An array of strings where each item represents a line of wrapped text.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [''];

  // Handle case where a single word is longer than maxWidth
  if (text.length <= maxWidth) return [text];

  const lines: string[] = [];
  let currentLine = '';

  // Split by any whitespace and preserve URLs
  const words = text.split(/(\s+)/).filter((word) => word.trim().length > 0);

  for (const word of words) {
    // If the word itself is longer than maxWidth, split it
    if (word.length > maxWidth) {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
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

/**
 * Retrieves the width of the terminal window.
 * If the width cannot be determined, it defaults to 80.
 *
 * @returns {number} The width of the terminal window or 80 if width cannot be determined.
 */
function getTerminalWidth(): number {
  return process.stdout.columns || 80; // Default to 80 if width cannot be determined
}

/**
 * Calculates the optimal column widths based on the terminal width and the data from an array of cvms.
 *
 * @param {GetCvmsByUserIdResponse} cvms - The array of cvms data to calculate column widths for
 * @returns {{key: string; value: number;}} - An object containing the calculated widths for each column
 */
function calculateColumnWidths(cvms: GetCvmsByUserIdResponse): {
  [key: string]: number;
} {
  const terminalWidth = getTerminalWidth();

  // Account for all border characters in total width ("|" at start/end and between columns, plus 2 spaces per column)
  const totalBorderWidth = 13; // | + 4 columns with "| " and " |" = 1 + 4 * 3 = 13
  const availableContentWidth = terminalWidth - totalBorderWidth;

  // Calculate the maximum content width for dynamic columns (name and status)
  const contentWidths = {
    name: Math.max(10, 'Agent Name'.length, ...cvms.map((cvm) => cvm.hosted.name.length)),
    status: Math.max(6, 'Status'.length, ...cvms.map((cvm) => cvm.hosted.status.length)),
  };

  // Calculate remaining width for App ID and App URL
  const remainingWidth = Math.max(
    0,
    availableContentWidth - contentWidths.name - contentWidths.status
  );

  // Split remaining width between App ID (1/3) and App URL (2/3)
  const appIdWidth = Math.max(8, Math.floor(remainingWidth * 0.33));
  const appUrlWidth = Math.max(7, remainingWidth - appIdWidth);

  // If total width would exceed terminal, scale everything down proportionally
  const totalWidth =
    contentWidths.name + contentWidths.status + appIdWidth + appUrlWidth + totalBorderWidth;
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

/**
 * Formats and prints a table of CVMs based on user ID.
 *
 * @param {GetCvmsByUserIdResponse} cvms - The CVMs to be formatted and displayed.
 * @returns {void}
 */
function formatCvmsTable(cvms: GetCvmsByUserIdResponse): void {
  const columnWidths = calculateColumnWidths(cvms);

  // Create header separator
  const separator = `+-${'-'.repeat(columnWidths.name)}-+-${'-'.repeat(columnWidths.status)}-+-${'-'.repeat(columnWidths.appId)}-+-${'-'.repeat(columnWidths.appUrl)}-+`;

  // Print header
  console.log(separator);
  console.log(
    `| ${'Agent Name'.padEnd(columnWidths.name)} | ${'Status'.padEnd(columnWidths.status)} | ${'App ID'.padEnd(columnWidths.appId)} | ${'App URL'.padEnd(columnWidths.appUrl)} |`
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
      appUrlLines.length
    );

    // Print each line of the row
    for (let i = 0; i < maxLines; i++) {
      console.log(
        `| ${(nameLines[i] || '').padEnd(columnWidths.name)} | ` +
          `${(statusLines[i] || '').padEnd(columnWidths.status)} | ` +
          `${(appIdLines[i] || '').padEnd(columnWidths.appId)} | ` +
          `${(appUrlLines[i] || '').padEnd(columnWidths.appUrl)} |`
      );
    }

    // Add a separator after each row
    console.log(separator);
  });

  // Print total count
  console.log(`\nTotal CVMs: ${cvms.length}`);
}

/**
 * Asynchronously queries the Phala Cloud API to retrieve information about teepods.
 *
 * @returns {Promise<any>} The data retrieved from the API.
 */
async function queryTeepods(): Promise<any> {
  try {
    const response = await axios.get(`${PHALA_CLOUD_API_URL}/api/v1/teepods`, {
      headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
    });
    return response.data;
  } catch (error: any) {
    console.error('Error during teepod query:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Query images of a teepod from the Phala Cloud API.
 * @param {string} teepodId - The ID of the teepod for which images are being queried.
 * @returns {Promise<any>} - A promise that resolves with the response data if successful, or null if an error occurs.
 */
async function queryImages(teepodId: string): Promise<any> {
  try {
    const response = await axios.get(`${PHALA_CLOUD_API_URL}/api/v1/teepods/${teepodId}/images`, {
      headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
    });
    return response.data;
  } catch (error: any) {
    console.error('Error during image query:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Asynchronously queries Cvms by user ID.
 *
 * @returns {Promise<GetCvmsByUserIdResponse | null>} The response containing Cvms related to the user ID, or null if an error occurs.
 */
async function queryCvmsByUserId(): Promise<GetCvmsByUserIdResponse | null> {
  try {
    const userInfo = await getUserInfo();
    const response = await axios.get(`${PHALA_CLOUD_API_URL}/api/v1/cvms?user_id=${userInfo?.id}`, {
      headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
    });
    return response.data as GetCvmsByUserIdResponse;
  } catch (error: any) {
    console.error('Error during get cvms by user id:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Asynchronous function to create a Custom Virtual Machine (CVM) based on the provided configuration.
 *
 * @param {any} vm_config The configuration object for the Custom Virtual Machine.
 * @returns {Promise<CreateCvmResponse | null>} A Promise that resolves with the response data if successful, or null if an error occurs.
 */
async function createCvm(vm_config: any): Promise<CreateCvmResponse | null> {
  try {
    const response = await axios.post(
      `${PHALA_CLOUD_API_URL}/api/v1/cvms/from_cvm_configuration`,
      vm_config,
      {
        headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
      }
    );
    return response.data as CreateCvmResponse;
  } catch (error: any) {
    console.error('Error during create cvm:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Retrieves a public key from the Cloud API based on the provided CVM configuration.
 *
 * @async
 * @function getPubkeyFromCvm
 * @param {Object} vm_config - The CVM configuration for which to retrieve the public key.
 * @returns {Promise<GetPubkeyFromCvmResponse | null>} The response containing the public key, or null if an error occurs.
 */
async function getPubkeyFromCvm(vm_config: any): Promise<GetPubkeyFromCvmResponse | null> {
  try {
    const response = await axios.post(
      `${PHALA_CLOUD_API_URL}/api/v1/cvms/pubkey/from_cvm_configuration`,
      vm_config,
      {
        headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
      }
    );
    return response.data as GetPubkeyFromCvmResponse;
  } catch (error: any) {
    console.error('Error during get pubkey from cvm:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Fetches the CVM (Containerized Virtual Machine) information by the given application ID.
 *
 * @param {string} appId - The ID of the application to retrieve CVM information for.
 * @returns {Promise<GetCvmByAppIdResponse | null>} A Promise that resolves with the CVM information or null if an error occurs.
 */
async function getCvmByAppId(appId: string): Promise<GetCvmByAppIdResponse | null> {
  try {
    const response = await axios.get(`${PHALA_CLOUD_API_URL}/api/v1/cvms/app_${appId}`, {
      headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
    });
    return response.data as GetCvmByAppIdResponse;
  } catch (error: any) {
    console.error('Error during get cvm by app id:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Asynchronously retrieves the user information from the Phala Cloud API.
 *
 * @returns A Promise that resolves with the user information in the form of GetUserInfoResponse, or null if an error occurs.
 */
async function getUserInfo(): Promise<GetUserInfoResponse | null> {
  try {
    const getUserAuth = await axios.get(`${PHALA_CLOUD_API_URL}/api/v1/auth/me`, {
      headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
    });
    const username = getUserAuth.data.username;
    const getEntityId = await axios.get(
      `${PHALA_CLOUD_API_URL}/api/v1/users/search?q=${username}`,
      {
        headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
      }
    );
    const userId = getEntityId.data.users[0].id;
    return { id: userId, username: username };
  } catch (error: any) {
    console.error('Error during get user info:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Upgrades a CVM for a specific app.
 * @param {string} appId - The ID of the app.
 * @param {any} vm_config - The configuration for the CVM.
 * @returns {Promise<UpgradeCvmResponse|null>} - The response from upgrading the CVM, or null if an error occurred.
 */
async function upgradeCvm(appId: string, vm_config: any): Promise<UpgradeCvmResponse | null> {
  try {
    const response = await axios.put(
      `${PHALA_CLOUD_API_URL}/api/v1/cvms/app_${appId}/compose`,
      vm_config,
      {
        headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
      }
    );
    return response.data as UpgradeCvmResponse;
  } catch (error: any) {
    console.error('Error during upgrade cvm:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Starts a CVM (Cloud Virtual Machine) with the specified App ID.
 * @param {string} appId - The ID of the app associated with the CVM to start.
 * @returns {Promise<any>} - The response data from starting the CVM.
 */
async function startCvm(appId: string): Promise<any> {
  try {
    const response = await axios.post(
      `${PHALA_CLOUD_API_URL}/api/v1/cvms/app_${appId}/start`,
      { app_id: appId },
      {
        headers: { ...headers, 'X-API-Key': await retrieveApiKey() },
      }
    );
    return response.data;
  } catch (error: any) {
    console.error('Error during start cvm:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Asynchronously fetches CVMs associated with the user's account and displays them in a formatted table.
 *
 * @returns {Promise<void>} A Promise that resolves once the CVMs are fetched and displayed.
 */
async function listCvms(): Promise<void> {
  console.log('Fetching your CVMs...');
  const cvms = await queryCvmsByUserId();

  if (!cvms || cvms.length === 0) {
    console.log('No CVMs found for your account.');
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
