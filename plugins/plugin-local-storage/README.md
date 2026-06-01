# @elizaos/plugin-local-storage

Local filesystem attachment storage for Eliza agents. This is the default
fallback storage backend used when Eliza Cloud storage is not connected.

The plugin registers a `Service` under `ServiceType.REMOTE_FILES` so consumers
that previously read from `runtime.getService(ServiceType.REMOTE_FILES)` keep
working without code changes after the deprecated `@elizaos/plugin-s3-storage`
package was removed.

## Storage root

The root directory is resolved in this order:

1. `runtime.getSetting("LOCAL_STORAGE_PATH")`
2. `process.env.LOCAL_STORAGE_PATH`
3. `<resolveStateDir()>/attachments` — `resolveStateDir()` from `@elizaos/core` honors `ELIZA_STATE_DIR`, then `$XDG_STATE_HOME/<namespace>`, then `~/.local/state/<namespace>` (namespace defaults to `eliza`).

The directory is created on `start()` if missing.

## Surface

`LocalFileStorageService` exposes the same method names as the removed
`AwsS3Service` so call sites can be retargeted with no refactor:

- `uploadFile(filePath, subDirectory?)`
- `uploadBytes(data, fileName, contentType, subDirectory?)`
- `uploadJson(jsonData, fileName?, subDirectory?)`
- `downloadBytes(_unusedBucket, key)`
- `downloadFile(_unusedBucket, key, localPath)`
- `delete(_unusedBucket, key)`
- `exists(_unusedBucket, key)`
- `generateSignedUrl(fileName, _expiresIn?)` — returns a `file://` absolute path

`_unusedBucket` parameters exist purely for drop-in API compatibility with
the previous S3 service. They are ignored — keys always resolve under the
configured storage root.

## Usage

Add `@elizaos/plugin-local-storage` to an agent's plugin list (it is opt-in,
not globally auto-enabled). The default export `localStoragePlugin` registers
`LocalFileStorageService` and nothing else — no actions, providers, evaluators,
routes, or events. Resolve the service with
`runtime.getService(ServiceType.REMOTE_FILES)`.

`generateSignedUrl` returns a permanent `file://` path, not an expiring URL. If
you need a public or expiring URL, route attachment storage through Eliza Cloud
instead.
