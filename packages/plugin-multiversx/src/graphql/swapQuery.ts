import { gql } from "graphql-request";

const transactionsPlaceholder = "TRANSACTIONS_PLACEHOLDER";

const transactionAttributes = `
  value
  receiver
  gasPrice
  gasLimit
  data
  chainID
  version
`;

const transactionsString = `
  noAuthTransactions(sender: $sender) {
    ${transactionAttributes}
  }
`;

const swapString = `
  query swapPackageSwapRoute (
    $amountIn: String
    $amountOut: String
    $tokenInID: String!
    $tokenOutID: String!
    $tolerance: Float!
    $sender: String!
  ) {
    swap(
      amountIn: $amountIn
      amountOut: $amountOut
      tokenInID: $tokenInID
      tokenOutID: $tokenOutID
      tolerance: $tolerance
    ) {
      amountIn
      tokenInID

      amountOut
      tokenOutID

      ${transactionsPlaceholder}
    }
  }
`;

export const swapQuery = gql`
    ${swapString.replace(transactionsPlaceholder, transactionsString)}
`;
