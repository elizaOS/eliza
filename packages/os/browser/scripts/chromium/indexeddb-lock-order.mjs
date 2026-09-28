/** Fixes order-independent IndexedDB lock membership on both owned platforms. */
export function applyIndexedDBLockOrder(edit, replaceOnce) {
  edit("content/browser/indexed_db/instance/connection.cc", (source) => {
    source = replaceOnce(
      source,
      '#include "base/stl_util.h"\n',
      "",
      "unused sorted intersection include",
    );
    return replaceOnce(
      source,
      `        return !base::STLSetIntersection<std::vector<PartitionedLockId>>(
                    lock_ids, existing_transaction.second->lock_ids())
                    .empty();`,
      `        // Blocked lock IDs preserve request order, which need not be sorted.
        const auto held_lock_ids = existing_transaction.second->lock_ids();
        return std::ranges::any_of(lock_ids, [&](const PartitionedLockId& id) {
          return held_lock_ids.contains(id);
        });`,
      "order-independent blocked lock membership",
    );
  });
  edit(
    "content/browser/indexed_db/instance/transaction_unittest.cc",
    (source) =>
      replaceOnce(
        source,
        "TEST_P(TransactionTest, IsTransactionBlockingOtherClients) {",
        `TEST_P(TransactionTest, HoldingLocksDoesNotRequireSortedInput) {
  auto connection = CreateConnection();
  Transaction* transaction =
      CreateTransaction(connection.get(), /*id=*/0, {2, 10, 128, 256},
                        blink::mojom::IDBTransactionMode::ReadWrite);
  ASSERT_EQ(transaction->state(), Transaction::STARTED);

  const auto held_lock_ids = transaction->lock_ids();
  ASSERT_GT(held_lock_ids.size(), 1u);
  const std::vector<PartitionedLockId> reversed_lock_ids(held_lock_ids.rbegin(),
                                                         held_lock_ids.rend());
  EXPECT_TRUE(connection->IsHoldingLocks(reversed_lock_ids));
  EXPECT_FALSE(connection->IsHoldingLocks({}));
  EXPECT_FALSE(connection->IsHoldingLocks({{-1, "not-held"}}));
  EXPECT_TRUE(connection->IsHoldingLocks(
      {{-1, "not-held"}, reversed_lock_ids.front()}));
}

TEST_P(TransactionTest, MultipleObjectStoreLocksAcrossClients) {
  auto connection = CreateConnection();
  auto other_connection = CreateConnection();
  ASSERT_NE(connection->client_token(), other_connection->client_token());

  // Numeric scope order differs from SQLite's serialized lock-key order.
  const std::vector<int64_t> object_store_ids = {2, 10, 128, 256};
  Transaction* blocker =
      CreateTransaction(connection.get(), /*id=*/0, object_store_ids,
                        blink::mojom::IDBTransactionMode::ReadWrite);
  ASSERT_EQ(blocker->state(), Transaction::STARTED);
  EXPECT_FALSE(blocker->IsTransactionBlockingOtherClients());

  Transaction* cancelled =
      CreateTransaction(other_connection.get(), /*id=*/0, object_store_ids,
                        blink::mojom::IDBTransactionMode::ReadWrite);
  EXPECT_EQ(cancelled->state(), Transaction::CREATED);
  EXPECT_TRUE(blocker->IsTransactionBlockingOtherClients());
  cancelled->Abort(DatabaseError(blink::mojom::IDBException::kUnknownError));
  FlushBucketTasks();
  EXPECT_FALSE(blocker->IsTransactionBlockingOtherClients());

  Transaction* waiter =
      CreateTransaction(other_connection.get(), /*id=*/1, object_store_ids,
                        blink::mojom::IDBTransactionMode::ReadWrite);
  EXPECT_EQ(waiter->state(), Transaction::CREATED);
  EXPECT_TRUE(blocker->IsTransactionBlockingOtherClients());
  blocker->Abort(DatabaseError(blink::mojom::IDBException::kUnknownError));
  FlushBucketTasks();
  EXPECT_EQ(waiter->state(), Transaction::STARTED);
  EXPECT_FALSE(waiter->IsTransactionBlockingOtherClients());
}

` + "TEST_P(TransactionTest, IsTransactionBlockingOtherClients) {",
        "multi-client lock-order regression tests",
      ),
  );
}
