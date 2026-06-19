"""
Database utilities for Calendar MCP Server

Handles data operations for the simplified Calendar implementation.
"""

import os
import sys
from typing import Dict, List, Any, Optional
from datetime import datetime, timezone

# Add project root to path
# project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# sys.path.insert(0, project_root)
# Add project root and current directory to path
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, project_root)
sys.path.insert(0, current_dir)


from common.database import JsonDatabase


class CalendarDatabase:
    """Database handler for Calendar data"""

    def __init__(self, data_dir: str = None):
        """Initialize database with data directory"""
        if data_dir is None:
            # Default to data directory in the same folder as this file
            data_dir = os.path.join(os.path.dirname(__file__), "data")

        # Store data directory
        self.data_dir = data_dir

        # Ensure database is initialized
        self._ensure_database_initialized()

        self.json_db = JsonDatabase(data_dir)

        # File mappings
        self.events_file = "events.json"

        # Load events into memory for faster access
        self._events_cache = None

    def _ensure_database_initialized(self):
        """Ensure database is initialized, create if needed"""
        try:
            from .init_database import check_database_initialized, initialize_database
        except ImportError:
            # Fallback for direct module execution
            from init_database import check_database_initialized, initialize_database

        quiet = os.environ.get('LOCA_QUIET', '').lower() in ('1', 'true', 'yes')
        if not check_database_initialized(self.data_dir):
            if not quiet:
                print(f"Database not found or incomplete. Initializing new database in: {self.data_dir}", file=sys.stderr)
            initialize_database(self.data_dir, verbose=not quiet, with_samples=False)
            if not quiet:
                print("Database initialization complete", file=sys.stderr)

    def _load_events(self) -> List[Dict[str, Any]]:
        """Load events from file, with caching"""
        if self._events_cache is None:
            self._events_cache = self.json_db.load_data(self.events_file)
            # Ensure it's a list
            if not isinstance(self._events_cache, list):
                self._events_cache = []
        return self._events_cache

    def _save_events(self, events: List[Dict[str, Any]]) -> bool:
        """Save events to file and update cache"""
        success = self.json_db.save_data(self.events_file, events)
        if success:
            self._events_cache = events
        return success

    def _parse_datetime(self, dt_string: str) -> datetime:
        """Parse ISO format datetime string, always return timezone-aware datetime"""
        # Handle both with and without timezone
        try:
            # Try parsing with timezone
            dt = datetime.fromisoformat(dt_string.replace('Z', '+00:00'))
            # If already timezone-aware, return as is
            if dt.tzinfo is not None:
                return dt
            # If naive, assume UTC
            return dt.replace(tzinfo=timezone.utc)
        except:
            # Try without timezone, then add UTC
            try:
                dt = datetime.fromisoformat(dt_string)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except:
                # Last resort: return current time with UTC
                return datetime.now(timezone.utc)

    def _compare_datetime(self, event: Dict[str, Any], time_min: str = None, time_max: str = None) -> bool:
        """Check if event falls within the specified time range"""
        if time_min is None and time_max is None:
            return True

        # Get event start time
        start_info = event.get("start", {})

        # Handle all-day events (date only)
        if "date" in start_info:
            event_date = start_info["date"]
            # For all-day events, just compare dates
            if time_min and event_date < time_min.split('T')[0]:
                return False
            if time_max and event_date > time_max.split('T')[0]:
                return False
            return True

        # Handle datetime events
        if "dateTime" in start_info:
            event_datetime = self._parse_datetime(start_info["dateTime"])

            if time_min:
                min_datetime = self._parse_datetime(time_min)
                if event_datetime < min_datetime:
                    return False

            if time_max:
                max_datetime = self._parse_datetime(time_max)
                if event_datetime > max_datetime:
                    return False

            return True

        return False

    def get_event(self, event_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific event by ID"""
        events = self._load_events()
        for event in events:
            if event.get("id") == event_id:
                return event.copy()
        return None

    def list_events(self, time_min: str = None, time_max: str = None,
                   max_results: int = None, order_by: str = "startTime") -> List[Dict[str, Any]]:
        """List events within a time range"""
        events = self._load_events()

        # Filter by time range
        filtered_events = [
            event.copy() for event in events
            if self._compare_datetime(event, time_min, time_max)
        ]

        # Sort events
        if order_by == "startTime":
            def get_start_key(event):
                start = event.get("start", {})
                return start.get("dateTime") or start.get("date") or ""
            filtered_events.sort(key=get_start_key)
        elif order_by == "updated":
            filtered_events.sort(key=lambda e: e.get("updated", ""))

        # Limit results
        if max_results and max_results > 0:
            filtered_events = filtered_events[:max_results]

        return filtered_events

    def create_event(self, event_data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new event"""
        events = self._load_events()

        # Generate new event ID
        max_id = 0
        for event in events:
            event_id = event.get("id", "")
            if event_id.startswith("event_"):
                try:
                    id_num = int(event_id.split("_")[1])
                    max_id = max(max_id, id_num)
                except:
                    pass

        new_id = f"event_{max_id + 1:03d}"

        # Add metadata
        now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        new_event = {
            "id": new_id,
            "created": now,
            "updated": now,
            "status": "confirmed",
            "creator": {
                "email": "user@example.com",
                "displayName": "Current User"
            },
            "organizer": {
                "email": "user@example.com",
                "displayName": "Current User"
            },
            "attendees": [],
            **event_data
        }

        events.append(new_event)
        self._save_events(events)

        return new_event.copy()

    def update_event(self, event_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Update an existing event"""
        events = self._load_events()

        for i, event in enumerate(events):
            if event.get("id") == event_id:
                # Update fields
                for key, value in updates.items():
                    if value is not None:  # Only update if value is provided
                        event[key] = value

                # Update timestamp
                event["updated"] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

                events[i] = event
                self._save_events(events)

                return event.copy()

        return None

    def delete_event(self, event_id: str) -> bool:
        """Delete an event"""
        events = self._load_events()

        for i, event in enumerate(events):
            if event.get("id") == event_id:
                events.pop(i)
                self._save_events(events)
                return True

        return False

    def get_all_events(self) -> List[Dict[str, Any]]:
        """Get all events"""
        return [event.copy() for event in self._load_events()]

    def get_database_stats(self) -> Dict[str, Any]:
        """Get database statistics"""
        events = self._load_events()

        stats = {
            "total_events": len(events),
            "files": {
                self.events_file: {
                    "size_bytes": self.json_db.get_file_size(self.events_file),
                    "exists": self.json_db.file_exists(self.events_file)
                }
            }
        }

        # Count upcoming vs past events
        now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        upcoming = sum(1 for e in events if self._compare_datetime(e, time_min=now))
        stats["upcoming_events"] = upcoming
        stats["past_events"] = len(events) - upcoming

        return stats
