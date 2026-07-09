1. Create `createPendantSessionSyncClient({ onSnapshot })` in the pendant owner.
2. Call `createSession()` when capture starts, then `acquireLease()`.
3. Keep the returned `leaseToken` only in memory on the capturing device.
4. Send ASR partials with `appendSegment()` using contiguous ordinals.
5. Send ASR/diarization revisions with `patchSegment()` and next segment revision.
6. Followers call `startPolling(sessionId)` and render only returned snapshots.
7. Followers may call `pause()`, `resume()`, `end()`, and `upsertInsightRefs()`.
8. Network failures stay explicit in `unsyncedQueue`; resolve conflicts with `discardUnsyncedMutation()` before retrying.
9. Segment IDs conflict with the insights branch text-derived `makePendantSegmentId`; insights must consume `pendantSegmentId(sessionId, ordinal)`.
10. Resolve both shared/ui barrel conflicts by keeping existing exports plus `pendant-session-sync` and `session-sync-client`.
