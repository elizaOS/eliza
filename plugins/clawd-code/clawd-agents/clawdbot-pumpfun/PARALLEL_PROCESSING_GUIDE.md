# Parallel Processing & Must-Selling System

This document describes the new parallel processing system implemented to prevent losing selling transactions and ensure bot security.

## 🚀 Overview

The new system implements parallel processing for all buy/sell operations, ensuring that the main monitoring stream is never blocked by transaction processing. The system includes robust must-selling logic with multiple fallbacks and automatic balance management.

## 🏗️ Architecture

### Main Stream (Non-blocking)
- The main Yellowstone gRPC stream continues monitoring target transactions
- All buy/sell operations are submitted to parallel processors immediately (non-blocking)
- The stream continues processing new transactions without waiting for previous operations

### Parallel Transaction Processor
- All buy/sell operations are executed in separate spawned tasks
- Multiple operations can run simultaneously
- Each operation has its own retry logic and error handling

### Must-Selling Logic
For every sell operation, the system attempts multiple strategies:

1. **Native DEX Selling (3 retries)**
   - Uses PumpFun, PumpSwap, or RaydiumLaunchpad
   - Fastest execution with minimal latency
   - Uses cached balance information for speed

2. **Jupiter API Fallback (3 retries)**
   - If native DEX fails, automatically tries Jupiter API
   - Checks token balance and executes Jupiter swap
   - Includes automatic SOL/WSOL balance management

3. **Balance Verification**
   - Verifies token balance before attempting sell
   - Skips if no balance found (prevents unnecessary errors)

### Balance Monitoring Service
- Checks wallet every 2 minutes for any remaining tokens
- Automatically sells all tokens using Jupiter API (same as `cargo r -- --sell`)
- Triggers SOL/WSOL balance management
- Wraps SOL for next trades if needed

## 🔧 Configuration

### Environment Variables

```env
# Balance monitoring interval (default: 120 seconds)
BALANCE_MONITOR_INTERVAL_SECONDS=120

# Auto-wrapping settings
AUTO_WRAP_ENABLED=true
WRAP_AMOUNT=0.1

# Balance management settings
SOL_WSOL_TARGET_RATIO=0.5  # 50% SOL, 50% WSOL
REBALANCE_THRESHOLD=0.2    # Rebalance at 20% deviation
```

## 📊 Key Features

### 1. Non-blocking Operation Submission
```rust
// Main stream submits operations and continues immediately
parallel_processor.submit_buy_operation(trade_info)?;
parallel_processor.submit_sell_operation(trade_info)?;
```

### 2. Must-Selling with Fallbacks
```
Target sells token → Submit sell operation → Background processing:
├── Native DEX (3 retries) → Success ✅
├── Jupiter API (3 retries) → Success ✅  
└── Log failure and continue
```

### 3. Balance Monitoring
```
Every 2 minutes:
├── Check for sellable tokens
├── If found: Execute emergency sell all
├── SOL/WSOL balance management
└── Auto-wrap SOL for next trades
```

### 4. Error Handling
- 3 retries for all selling operations
- Detailed error logging
- Graceful fallback between strategies
- No operation blocks the main stream

## 🛡️ Security Features

### 1. Must-Selling Logic
- Multiple fallback strategies ensure tokens are sold
- Balance verification prevents unnecessary operations
- Automatic retry with exponential backoff

### 2. Balance Management
- Automatic SOL/WSOL rebalancing after sells
- Maintains optimal ratios for different DEXes
- Prevents balance accumulation issues

### 3. Continuous Monitoring
- Background service checks balances every 2 minutes
- Sells any accumulated tokens automatically
- Wraps SOL to prepare for next trades

### 4. Parallel Processing
- Main monitoring stream never blocks
- All operations run independently
- Results monitoring provides feedback

## 📝 Usage Examples

### Starting the Bot
```bash
# Start with new parallel processing system
cargo run

# All operations now run in parallel automatically
# Main stream continues monitoring while operations execute in background
```

### Manual Operations (Still Available)
```bash
# Manual sell all (same logic used by balance monitor)
cargo run -- --sell

# Manual balance management
cargo run -- --balance

# Manual SOL wrapping
cargo run -- --wrap
```

### Monitoring Operations
The system provides detailed logging for all parallel operations:

```
🚀 Submitting BUY operation to parallel processor for token: ABC123...
✅ BUY operation submitted successfully for token: ABC123...
🎉 Parallel operation completed successfully: Buy(ABC123) in 1.2s - Signature: xyz789...

🚀 Submitting SELL operation to parallel processor for token: DEF456...
🔄 Processing SELL operation with must-selling for token: DEF456...
🎯 SELL attempt 1/3 using native DEX for token: DEF456...
✅ Native DEX sell completed for token: DEF456 (attempt 1)
```

## 🔍 Benefits

### 1. No Missed Transactions
- Main stream never blocks, continues monitoring at full speed
- All buy/sell operations are queued and processed in parallel
- Multiple fallback strategies for selling

### 2. Improved Performance
- Operations run simultaneously instead of sequentially
- Cached balance information reduces RPC calls
- Optimized transaction processing

### 3. Enhanced Security
- Must-selling logic ensures tokens don't accumulate
- Balance monitoring catches any missed sells
- Automatic balance management prevents trading issues

### 4. Better Error Handling
- 3 retries for all operations
- Graceful fallbacks between strategies
- Detailed error reporting

## 📈 Monitoring & Statistics

The system provides comprehensive monitoring:

- Trading statistics (buy/sell counts)
- Parallel operation results
- Balance monitoring status
- Error rates and retry statistics

## 🚨 Important Notes

1. **All selling operations now have 3 retries with Jupiter fallback**
2. **Main monitoring stream is completely non-blocking**
3. **Balance monitoring runs every 2 minutes by default**
4. **SOL/WSOL balance management is automatic**
5. **The system is backward compatible with existing commands**

## 🔧 Troubleshooting

### If sells are failing:
1. Check Jupiter API connectivity
2. Verify wallet has sufficient SOL for transaction fees
3. Check balance monitoring logs for details

### If balance monitoring isn't working:
1. Verify `BALANCE_MONITOR_INTERVAL_SECONDS` setting
2. Check for RPC connection issues
3. Ensure wallet permissions are correct

### If operations seem slow:
1. Check RPC endpoint performance
2. Verify network connectivity
3. Monitor parallel processor queue status
