# @valhalla/brain-sdk

Read-only client for the Valhalla Brain API. Scores are informational. They are not financial advice and they do not promise profit.

```ts
import { BrainClient } from "@valhalla/brain-sdk";

const client = new BrainClient("https://YOUR-WORKER.workers.dev", process.env.VALHALLA_BRAIN_KEY ?? "");
const result = await client.score("So11111111111111111111111111111111111111112");
```

curl:

```bash
curl -s https://YOUR-WORKER.workers.dev/v1/health
curl -s -H "Authorization: Bearer $VALHALLA_BRAIN_KEY" \
  https://YOUR-WORKER.workers.dev/v1/score/So11111111111111111111111111111111111111112
curl -s -H "Authorization: Bearer $VALHALLA_BRAIN_KEY" \
  -H "content-type: application/json" \
  -d '{"mints":["So11111111111111111111111111111111111111112"]}' \
  https://YOUR-WORKER.workers.dev/v1/score/batch
```

The score is informational. It is not financial advice and it does not promise profit.
