# ElizaOS Trenches Chat Dataset

A comprehensive dataset of Discord trading discussions from the ElizaOS Trenches community, featuring enriched trading calls with price performance metrics and user trust scores.

**Note:** The native token AI16Z has been filtered from this dataset to prevent overrepresentation and allow better analysis of other tokens.

## 📊 Dataset Overview

- **Time Period**: October 26, 2024 - January 2, 2025  
- **Total Messages**: 267,183
- **Trading Calls**: 61,011
- **Unique Tokens**: 3,481  
- **Active Users**: 1,790
- **File Formats**: JSON and Parquet (placeholder)
- **Compressed Size**: ~25MB (ZIP/TAR.GZ)

## 📁 Dataset Structure

```
trenches-chat-dataset/
├── data/
│   ├── messages.json         # All Discord messages with call labels
│   ├── messages.parquet      # Parquet format (placeholder)
│   ├── calls.json           # Enriched trading calls with metrics
│   ├── calls.parquet        # Parquet format (placeholder)
│   ├── tokens.json          # Token manifest with statistics
│   ├── tokens.parquet       # Parquet format (placeholder)
│   ├── users.json           # User manifest with performance metrics
│   ├── users.parquet        # Parquet format (placeholder)
│   └── price_history/       # Historical OHLCV data per token
│       ├── {token_address}.json
│       └── ...
├── compressed/
│   ├── trenches-dataset.zip
│   └── trenches-dataset.tar.gz
└── examples/
    ├── python/
    │   └── load_dataset.py  # Python usage example
    └── javascript/
        └── load_dataset.js  # JavaScript usage example
```

## 🔍 Data Schemas

### Messages Dataset
```json
{
  "message_id": "string",
  "user_id": "string", 
  "username": "string",
  "timestamp": "number",
  "content": "string",
  "date": "ISO 8601 string",
  "is_call": "boolean",
  "call_id": "string (optional)"
}
```

### Calls Dataset
```json
{
  "call_id": "string",
  "message_id": "string",
  "user_id": "string",
  "username": "string",
  "timestamp": "number",
  "content": "string",
  "token_mentioned": "string",
  "token_address": "string",
  "chain": "string",
  "sentiment": "positive|neutral|negative",
  "conviction": "high|medium|low|neutral",
  "llm_reasoning": "string",
  "certainty": "string",
  "price_at_call": "number",
  "price_data": {
    "calledPrice": "number",
    "bestPrice": "number",
    "worstPrice": "number",
    "idealProfitLossPercent": "number"
  },
  "enrichment_status": "string",
  "enrichment_error": "string (optional)"
}
```

### Token Manifest
```json
{
  "address": "string",
  "symbol": "string", 
  "name": "string",
  "chain": "string",
  "call_count": "number",
  "first_mentioned": "timestamp",
  "last_mentioned": "timestamp"
}
```

### User Manifest
```json
{
  "user_id": "string",
  "username": "string",
  "total_messages": "number",
  "total_calls": "number",
  "successful_calls": "number",
  "failed_calls": "number",
  "neutral_calls": "number",
  "avg_profit_loss": "number",
  "total_profit_loss": "number",
  "best_call": "number",
  "worst_call": "number", 
  "success_rate": "number",
  "trust_score": "number",
  "first_message": "timestamp",
  "last_message": "timestamp",
  "tokens_called": ["string"]
}
```

### Price History
```json
{
  "address": "string",
  "symbol": "string",
  "chain": "string",
  "price_history": [{
    "timestamp": "number",
    "open": "number",
    "high": "number",
    "low": "number",
    "close": "number",
    "volume": "number"
  }],
  "fetched_at": "timestamp",
  "start_date": "ISO 8601 string",
  "end_date": "ISO 8601 string"
}
```

## 🚀 Quick Start

### Python Example
```python
from trenches_dataset import TrenchesDataset

# Load the dataset
dataset = TrenchesDataset("path/to/trenches-chat-dataset")

# Get all messages
messages = dataset.get_messages()

# Get trading calls
calls = dataset.get_calls()

# Get calls for a specific token
btc_calls = dataset.get_calls_by_token("BTC")

# Get user performance
user_stats = dataset.get_user_stats("user123")
```

### JavaScript Example
```javascript
import { TrenchesDataset } from './load_dataset.js';

// Load the dataset
const dataset = new TrenchesDataset('path/to/trenches-chat-dataset');

// Get all messages
const messages = await dataset.getMessages();

// Get trading calls
const calls = await dataset.getCalls();
```

## 📈 Use Cases

1. **Trading Signal Analysis**: Analyze the accuracy and timing of trading calls
2. **Sentiment Analysis**: Study market sentiment patterns in crypto discussions
3. **User Behavior**: Research trading community dynamics and influence patterns
4. **Price Impact Studies**: Correlate social signals with price movements
5. **Trust Score Models**: Build and validate trader reputation systems
6. **NLP Research**: Train models on crypto-specific language and terminology

## 🔧 Building the Dataset

If you want to rebuild the dataset from source:

```bash
# Clone the repository
git clone https://github.com/your-repo/trenches-dataset

# Install dependencies
bun install

# Build the dataset
bun run scripts/build_dataset.ts

# Fetch price history (takes ~2 hours)
bun run scripts/fetch_price_history.ts
```

**Note**: Price history fetching is rate-limited and may take several hours to complete for all tokens. The process is resumable if interrupted. 

## 📜 License

This dataset is provided for research and educational purposes. Please respect user privacy and use responsibly.