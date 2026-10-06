/**
 * An explicit earnings history limit of 0 is an empty page. `limit || 50`
 * asked the repository for the default page instead.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const listTransactions = mock(async () => []);
const listTransactionsByType = mock(async () => []);

mock.module("../../db/repositories/app-earnings", () => ({
  appEarningsRepository: {
    listTransactions,
    listTransactionsByType,
  },
}));

const { AppEarningsService } = await import("./app-earnings");

beforeEach(() => {
  listTransactions.mockClear();
  listTransactionsByType.mockClear();
});

test("treats an explicit earnings history limit of 0 as an empty page", async () => {
  const service = new AppEarningsService();

  await service.getTransactionHistory("app-1", { limit: 0 });
  expect(listTransactions).toHaveBeenCalledWith("app-1", 0, 0);

  await service.getTransactionHistory("app-1", { limit: 1, offset: 2 });
  expect(listTransactions).toHaveBeenLastCalledWith("app-1", 1, 2);

  await service.getTransactionHistory("app-1");
  expect(listTransactions).toHaveBeenLastCalledWith("app-1", 50, 0);

  await service.getTransactionHistory("app-1", {
    limit: 0,
    type: "withdrawal",
  });
  expect(listTransactionsByType).toHaveBeenCalledWith("app-1", "withdrawal", 0);
});
