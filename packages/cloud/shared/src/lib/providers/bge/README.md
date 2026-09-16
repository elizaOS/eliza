# BGE tokenizer assets

These runtime assets belong to `BAAI/bge-small-en-v1.5`, revision
`5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`:

- https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/tokenizer.json
- https://huggingface.co/BAAI/bge-small-en-v1.5/blob/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/tokenizer_config.json

The Cloudflare adapter tokenizes the complete input before dispatch because
Workers AI otherwise truncates inputs beyond this encoder's 512-token context.
The tokenizer does not truncate or pad inputs. Keep the model, revision,
CLS pooling, 384 dimensions, and L2 normalization together when changing the
embedding representation. Existing vectors require explicit re-indexing when
that representation changes.

The model card declares the MIT license and links to the
[FlagEmbedding license](https://github.com/FlagOpen/FlagEmbedding/blob/master/LICENSE).

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMBEDDING_API_TOKEN` to serve
`bge-small-en-v1.5` through Workers AI. The token needs Workers AI permission.
This explicit credential takes precedence over the TEI sidecar for that model.
Requests for other model IDs retain their own configured providers. Workers AI
errors propagate; the router does not substitute another embedding model.
