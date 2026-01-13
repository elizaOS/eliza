from __future__ import annotations

import logging
import math
import secrets
import time
from typing import Any

from .types import (
    BoundingBox,
    DetectedObject,
    EntityAppearance,
    EntityAttributes,
    PersonInfo,
    RecentlyLeftEntity,
    TrackedEntity,
    WorldState,
)

logger = logging.getLogger(__name__)


class EntityTracker:
    POSITION_THRESHOLD = 100
    MISSING_THRESHOLD = 5000
    CLEANUP_THRESHOLD = 60000

    def __init__(self, world_id: str):
        self._world_state = WorldState(
            world_id=world_id,
            entities={},
            last_update=int(time.time() * 1000),
            active_entities=[],
            recently_left=[],
        )

    async def update_entities(
        self,
        detected_objects: list[DetectedObject],
        people: list[PersonInfo],
        face_profiles: dict[str, str] | None = None,
        runtime: Any = None,
    ) -> list[TrackedEntity]:
        current_time = int(time.time() * 1000)
        frame_entities: list[TrackedEntity] = []
        seen_entity_ids: set[str] = set()

        for person in people:
            face_profile_id = face_profiles.get(person.id) if face_profiles else None
            entity = self._track_person(person, face_profile_id, current_time)
            frame_entities.append(entity)
            seen_entity_ids.add(entity.id)

        # Process detected objects
        for obj in detected_objects:
            if obj.type not in ("person", "person-candidate"):
                entity = self._track_object(obj, current_time)
                frame_entities.append(entity)
                seen_entity_ids.add(entity.id)

        self._update_world_state(seen_entity_ids, current_time)

        return frame_entities

    def _track_person(
        self,
        person: PersonInfo,
        face_profile_id: str | None,
        timestamp: int,
    ) -> TrackedEntity:
        matched_entity = self._find_matching_entity(person.bounding_box, "person", face_profile_id)

        if matched_entity:
            matched_entity.last_seen = timestamp
            matched_entity.last_position = person.bounding_box

            appearance = EntityAppearance(
                timestamp=timestamp,
                bounding_box=person.bounding_box,
                confidence=person.confidence,
                keypoints=person.keypoints,
            )
            matched_entity.appearances.append(appearance)

            if face_profile_id and not matched_entity.attributes.face_id:
                matched_entity.attributes.face_id = face_profile_id

            if len(matched_entity.appearances) > 100:
                matched_entity.appearances = matched_entity.appearances[-100:]

            return matched_entity

        entity_id = f"person-{timestamp}-{secrets.token_hex(4)}"
        new_entity = TrackedEntity(
            id=entity_id,
            entity_type="person",
            first_seen=timestamp,
            last_seen=timestamp,
            last_position=person.bounding_box,
            appearances=[
                EntityAppearance(
                    timestamp=timestamp,
                    bounding_box=person.bounding_box,
                    confidence=person.confidence,
                    keypoints=person.keypoints,
                )
            ],
            attributes=EntityAttributes(face_id=face_profile_id),
            world_id=self._world_state.world_id,
        )

        self._world_state.entities[entity_id] = new_entity
        logger.info(f"[EntityTracker] New person entity created: {entity_id}")

        return new_entity

    def _track_object(self, obj: DetectedObject, timestamp: int) -> TrackedEntity:
        matched_entity = self._find_matching_entity(obj.bounding_box, "object")

        if matched_entity:
            matched_entity.last_seen = timestamp
            matched_entity.last_position = obj.bounding_box
            matched_entity.appearances.append(
                EntityAppearance(
                    timestamp=timestamp,
                    bounding_box=obj.bounding_box,
                    confidence=obj.confidence,
                )
            )

            if len(matched_entity.appearances) > 50:
                matched_entity.appearances = matched_entity.appearances[-50:]

            return matched_entity

        entity_id = f"object-{timestamp}-{secrets.token_hex(4)}"
        new_entity = TrackedEntity(
            id=entity_id,
            entity_type="object",
            first_seen=timestamp,
            last_seen=timestamp,
            last_position=obj.bounding_box,
            appearances=[
                EntityAppearance(
                    timestamp=timestamp,
                    bounding_box=obj.bounding_box,
                    confidence=obj.confidence,
                )
            ],
            attributes=EntityAttributes(object_type=obj.type),
            world_id=self._world_state.world_id,
        )

        self._world_state.entities[entity_id] = new_entity
        logger.debug(f"[EntityTracker] New object entity created: {entity_id} ({obj.type})")

        return new_entity

    def _find_matching_entity(
        self,
        bounding_box: BoundingBox,
        entity_type: str,
        face_profile_id: str | None = None,
    ) -> TrackedEntity | None:
        current_time = int(time.time() * 1000)
        best_match: TrackedEntity | None = None
        min_distance = float("inf")

        for entity in self._world_state.entities.values():
            if entity.entity_type != entity_type:
                continue

            if current_time - entity.last_seen > self.MISSING_THRESHOLD:
                continue

            if entity_type == "person" and face_profile_id and entity.attributes.face_id:
                if entity.attributes.face_id == face_profile_id:
                    return entity

            distance = self._calculate_distance(entity.last_position, bounding_box)

            if distance < self.POSITION_THRESHOLD and distance < min_distance:
                min_distance = distance
                best_match = entity

        return best_match

    def _calculate_distance(self, box1: BoundingBox, box2: BoundingBox) -> float:
        center1 = box1.center()
        center2 = box2.center()
        return math.sqrt((center1.x - center2.x) ** 2 + (center1.y - center2.y) ** 2)

    def _update_world_state(self, seen_entity_ids: set[str], timestamp: int) -> None:
        previous_active = set(self._world_state.active_entities)
        self._world_state.active_entities = list(seen_entity_ids)
        self._world_state.last_update = timestamp

        for entity_id in previous_active:
            if entity_id not in seen_entity_ids:
                entity = self._world_state.entities.get(entity_id)
                if entity:
                    self._world_state.recently_left.append(
                        RecentlyLeftEntity(
                            entity_id=entity_id,
                            left_at=timestamp,
                            last_position=entity.last_position,
                        )
                    )
                    logger.info(f"[EntityTracker] Entity left scene: {entity_id}")

        # Clean up old "recently left" entries
        self._world_state.recently_left = [
            entry
            for entry in self._world_state.recently_left
            if timestamp - entry.left_at < self.CLEANUP_THRESHOLD
        ]

        entities_to_remove = [
            entity_id
            for entity_id, entity in self._world_state.entities.items()
            if timestamp - entity.last_seen > self.CLEANUP_THRESHOLD * 10
        ]
        for entity_id in entities_to_remove:
            del self._world_state.entities[entity_id]
            logger.debug(f"[EntityTracker] Cleaned up old entity: {entity_id}")

    def get_world_state(self) -> WorldState:
        return self._world_state

    def get_active_entities(self) -> list[TrackedEntity]:
        return [
            entity
            for entity_id in self._world_state.active_entities
            if (entity := self._world_state.entities.get(entity_id))
        ]

    def get_entity(self, entity_id: str) -> TrackedEntity | None:
        return self._world_state.entities.get(entity_id)

    def get_recently_left(self) -> list[tuple[TrackedEntity, int]]:
        result = []
        for entry in self._world_state.recently_left:
            entity = self._world_state.entities.get(entry.entity_id)
            if entity:
                result.append((entity, entry.left_at))
        return result

    def assign_name_to_entity(self, entity_id: str, name: str) -> bool:
        entity = self._world_state.entities.get(entity_id)
        if entity:
            entity.attributes.name = name
            logger.info(f"[EntityTracker] Assigned name '{name}' to entity {entity_id}")
            return True
        return False

    def get_statistics(self) -> dict[str, int]:
        entities = list(self._world_state.entities.values())
        return {
            "total_entities": len(entities),
            "active_entities": len(self._world_state.active_entities),
            "recently_left": len(self._world_state.recently_left),
            "people": sum(1 for e in entities if e.entity_type == "person"),
            "objects": sum(1 for e in entities if e.entity_type == "object"),
        }
