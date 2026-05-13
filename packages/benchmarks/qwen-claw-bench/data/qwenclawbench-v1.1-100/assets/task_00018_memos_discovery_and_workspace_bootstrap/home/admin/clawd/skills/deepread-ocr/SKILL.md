# DeepRead OCR

AI-native OCR platform that turns documents into high-accuracy data in minutes. Using multi-model consensus, DeepRead achieves 95%+ accuracy and flags only uncertain fields for review.

## When to Use

- Extracting text from scanned documents or images
- Processing invoices, receipts, forms
- Batch document digitization

## Configuration

```yaml
deepread:
  api_key: "${DEEPREAD_API_KEY}"
  endpoint: "https://api.deepread.ai/v1"
  consensus_models: 3
  confidence_threshold: 0.95
```
