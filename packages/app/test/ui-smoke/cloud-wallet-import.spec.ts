import { expect, type Page, test } from "@playwright/test";
import {
  installCloudWalletImportApiOverrides,
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

async function openWalletRpcSettings(page: Page) {
  await page.getByRole("button", { name: "Open RPC settings" }).click();
  await expect(page.getByTestId("wallet-rpc-mode-cloud")).toBeVisible({
    timeout: 15_000,
  });
}

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
});

test("inventory cloud import uses the live wallet API", async ({ page }) => {
  let walletConfigGetCount = 0;
  let refreshCloudCount = 0;

  page.on("request", (request) => {
    const url = request.url();
    if (request.method() === "GET" && url.endsWith("/api/wallet/config")) {
      walletConfigGetCount += 1;
    }
    if (
      request.method() === "POST" &&
      url.endsWith("/api/wallet/refresh-cloud")
    ) {
      refreshCloudCount += 1;
    }
  });

  await openAppPath(page, "/wallet");

  const cloudStatusResponse = await page.request.get("/api/cloud/status");
  expect(cloudStatusResponse.ok()).toBe(true);
  const cloudStatus = (await cloudStatusResponse.json()) as {
    connected?: boolean;
    hasApiKey?: boolean;
  };
  test.skip(
    !(cloudStatus.connected === true || cloudStatus.hasApiKey === true),
    "Eliza Cloud is not linked in this live stack.",
  );

  await expect
    .poll(() => walletConfigGetCount, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);

  const walletConfigResponse = await page.request.get("/api/wallet/config");
  expect(walletConfigResponse.ok()).toBe(true);
  const walletConfigBeforeImport = (await walletConfigResponse.json()) as {
    evmAddress?: string | null;
    solanaAddress?: string | null;
    wallets?: Array<{ address?: string | null }>;
  };
  const hasConnectedWallet =
    Boolean(walletConfigBeforeImport.evmAddress) ||
    Boolean(walletConfigBeforeImport.solanaAddress) ||
    Boolean(
      walletConfigBeforeImport.wallets?.some(
        (wallet) =>
          typeof wallet.address === "string" &&
          wallet.address.trim().length > 0,
      ),
    );
  test.skip(
    hasConnectedWallet,
    "Wallet import CTA is hidden once the live stack already has a wallet connected.",
  );

  await openWalletRpcSettings(page);

  const saveBtn = page.getByTestId("wallet-rpc-save");
  await expect(saveBtn).toBeVisible({ timeout: 15_000 });

  const walletConfigPutRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "PUT" &&
      request.url().endsWith("/api/wallet/config"),
    { timeout: 15_000 },
  );
  const walletConfigPutResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/api/wallet/config"),
    { timeout: 15_000 },
  );
  const refreshCloudResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/wallet/refresh-cloud"),
    { timeout: 15_000 },
  );

  await saveBtn.click();

  const walletConfigPutRequest = await walletConfigPutRequestPromise;
  const walletConfigPutResponse = await walletConfigPutResponsePromise;
  const refreshCloudResponse = await refreshCloudResponsePromise;

  expect(walletConfigPutResponse.status()).toBe(200);
  expect(refreshCloudResponse.status()).toBe(200);

  const putPayload = walletConfigPutRequest.postDataJSON() as {
    selections?: Record<string, string>;
    walletNetwork?: string;
  };
  expect(putPayload.selections).toEqual({
    evm: "eliza-cloud",
    bsc: "eliza-cloud",
    solana: "eliza-cloud",
  });
  expect(putPayload.walletNetwork).toBe("mainnet");

  await expect
    .poll(() => refreshCloudCount, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => walletConfigGetCount, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);

  const walletConfigAfterImportResponse =
    await page.request.get("/api/wallet/config");
  expect(walletConfigAfterImportResponse.ok()).toBe(true);
  const walletConfig = (await walletConfigAfterImportResponse.json()) as {
    selectedRpcProviders?: Record<string, string>;
  };
  expect(walletConfig.selectedRpcProviders).toEqual({
    evm: "eliza-cloud",
    bsc: "eliza-cloud",
    solana: "eliza-cloud",
  });
});

test("inventory cloud import refreshes cloud wallets after save", async ({
  page,
}) => {
  await installDefaultAppRoutes(page);
  const api = await installCloudWalletImportApiOverrides(page);

  await openAppPath(page, "/wallet");

  await openWalletRpcSettings(page);

  const saveBtn = page.getByTestId("wallet-rpc-save");
  await expect(saveBtn).toBeVisible({ timeout: 15_000 });
  await saveBtn.click();

  await expect
    .poll(() => api.lastWalletConfigPut(), { timeout: 15_000 })
    .not.toBeNull();

  const put = api.lastWalletConfigPut() as {
    selections?: Record<string, string>;
    walletNetwork?: string;
  };
  expect(put.selections).toEqual({
    evm: "eliza-cloud",
    bsc: "eliza-cloud",
    solana: "eliza-cloud",
  });
  expect(put.walletNetwork).toBe("mainnet");

  await expect
    .poll(() => api.refreshCloudRequestCount(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => api.walletConfigGetCount(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
});
