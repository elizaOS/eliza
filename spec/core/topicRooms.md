# Topic room observations

The complete multi-room service state is owned by [topicService](./topicService.md), which embeds [channelTopics](./channelTopics.md) for each room. This file is a pure projection library and owns no parallel room map or stopping flag.

## Story: Inspect independent room progress

### Every room observation reads the one authoritative room record

Room IDs preserve their first-admission order. Missing rooms have the empty per-room lifecycle. Queue counts and hydrated flags derive directly from that lifecycle, including while the whole service is stopping. The synchronous single-room accessor returns an empty list for a missing cache entry. The all-room snapshot follows local-cache insertion order (which can differ from first admission) and contains separate detached lists.

```quint
import topicService as P from "./topicService"
import channelTopics as T from "./channelTopics"
pure def observedRoom(s: P::TopicServiceRooms, id: str): T::TopicService = P::roomAt(s, id)
pure def roomIds(s: P::TopicServiceRooms): List[str] = s.rooms.listMap(room => room.id)
pure def totalQueued(s: P::TopicServiceRooms): int = s.rooms.foldl(0, (total, room) => total + room.unit.queue.length())
type LocalTopicEntry = { id: str, topics: List[str] }
pure def localTopicSnapshot(s: P::TopicServiceRooms): List[LocalTopicEntry] = s.cacheOrder.listMap(id => { id: id, topics: P::roomAt(s, id).localTopics })
pure def cachedTopics(s: P::TopicServiceRooms, id: str): List[str] = observedRoom(s, id).localTopics
pure def lawObservationMatchesOwner(s: P::TopicServiceRooms, id: str): bool = observedRoom(s, id) == P::roomAt(s, id)
pure val sValues: Set[P::TopicServiceRooms] = Set(P::initial)
```
