# Polygon zkEVM Plugin - UI Testing Prompts

Copy and paste these prompts to test the plugin functionality. Each section tests different actions and edge cases.

## 1. Current Block Number Tests

### Basic Current Block Requests

```
What is the current block number on Polygon zkEVM?
```

```
Get the latest block number for zkEVM
```

```
Show me the current Polygon zkEVM block
```

```
What block is Polygon zkEVM on right now?
```

```
Get block number on polygon zkevm
```

### Should NOT trigger current block (should trigger other actions)

```
Check the status of block 12345 on zkEVM
```

```
Get details for block 98765
```

```
What is the finality status of the latest block?
```

## 2. Block Status/Finality Tests

### Block Status Requests

```
Check the status of block 12345 on zkEVM
```

```
What is the finality status of block 98765?
```

```
Is block 11111 trusted or virtual on Polygon zkEVM?
```

```
Check if block 22222 is consolidated
```

```
Verify the status of the latest block
```

```
What's the confirmation status of block 33333?
```

### Should NOT trigger block status (should trigger current block)

```
What is the current block number?
```

```
Get the latest block number
```

## 3. Transaction Tests

### Transaction by Hash

```
Get details for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

```
Show me transaction 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

```
Look up tx 0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba
```

### Transaction Receipt

```
Get receipt for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
```

```
Show me the receipt for tx 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

## 4. Gas Estimation Tests

### Basic Gas Estimation

```
Estimate gas for sending 0.1 ETH to 0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b6
```

```
What would it cost to send 1 ETH to 0x1234567890123456789012345678901234567890?
```

```
Estimate gas for calling contract at 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef
```

```
How much gas to transfer 0.5 ETH from 0x1111111111111111111111111111111111111111 to 0x2222222222222222222222222222222222222222?
```

## 5. Block Details Tests

### Block Details by Number

```
Get details for block 12345
```

```
Show me information about block 98765
```

```
What's in block 11111 on zkEVM?
```

### Block Details by Hash

```
Get details for block 0xd5f1812548be429cbdc6376b29611fc49e06f1359758c4ceaaa3b393e2239f9c
```

```
Show me block 0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

## 6. Account and Balance Tests

### Account Balance

```
What's the balance of 0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b6?
```

```
Check balance for address 0x1234567890123456789012345678901234567890
```

```
How much ETH does 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef have?
```

### Transaction Count

```
How many transactions has 0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b6 sent?
```

```
Get nonce for address 0x1234567890123456789012345678901234567890
```

## 7. Contract Interaction Tests

### Contract Code

```
Get the code for contract 0x1234567890123456789012345678901234567890
```

```
Show me the bytecode at 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef
```

### Storage Reading

```
Read storage slot 0 from contract 0x1234567890123456789012345678901234567890
```

```
Get storage at position 1 for address 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef
```

## 8. Gas Price Tests

### Current Gas Price

```
What's the current gas price on Polygon zkEVM?
```

```
Show me gas price estimates
```

```
Get current gas fees for zkEVM
```

## 9. Event Logs Tests

### Event Logs

```
Get logs from contract 0x1234567890123456789012345678901234567890
```

```
Show me recent events from 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef
```

```
Get logs for the last 100 blocks
```

## 10. Batch Information Tests

### Batch Info

```
Get batch information for block 12345
```

```
Show me batch details for the latest block
```

## 11. Edge Cases and Error Handling

### Invalid Addresses

```
Get balance for invalid-address
```

```
Check balance of 0x123
```

### Invalid Transaction Hashes

```
Get transaction details for 0x123
```

```
Show me transaction invalid-hash
```

### Invalid Block Numbers

```
Get details for block -1
```

```
Show me block 999999999999
```

### Ambiguous Requests

```
Get block information
```

```
Show me blockchain data
```

```
Tell me about Polygon zkEVM
```

## 12. Mixed Context Tests

### Multiple Requests

```
Get the current block number and check the status of block 12345
```

```
What's the balance of 0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b6 and the current gas price?
```

## Expected Behaviors

### ✅ Should Work

- Current block number requests should use `getCurrentBlockNumberAction`
- Block status requests should use `checkBlockStatusAction`
- Transaction hash requests should use `getTransactionByHashAction`
- Gas estimation should use `estimateGasAction`
- All actions should handle errors gracefully
- All actions should provide helpful error messages

### ❌ Should NOT Happen

- "Get block number" should NOT trigger `checkBlockStatusAction`
- "Check block status" should NOT trigger `getCurrentBlockNumberAction`
- Invalid inputs should NOT crash the system
- Missing API keys should provide clear error messages

## Testing Notes

1. **API Keys**: Make sure you have `ALCHEMY_API_KEY` or `ZKEVM_RPC_URL` configured
2. **Network**: These tests are for Polygon zkEVM mainnet
3. **Rate Limits**: Be mindful of API rate limits when testing
4. **Real Data**: Use real transaction hashes and addresses for more realistic testing
5. **Error Handling**: Test both valid and invalid inputs to ensure robust error handling

## Quick Test Commands

For rapid testing, use these one-liners:

```bash
# Test current block
echo "What is the current block number on Polygon zkEVM?"

# Test block status
echo "Check the status of block 12345 on zkEVM"

# Test transaction
echo "Get details for transaction 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

# Test gas estimation
echo "Estimate gas for sending 0.1 ETH to 0x742d35Cc6634C0532925a3b8D4C9db96c4b4d8b6"
```
